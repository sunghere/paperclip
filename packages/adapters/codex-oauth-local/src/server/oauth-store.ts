// OAuth credential store — reads/writes auth.json compatible with codex CLI.
//
// File format (matches what `CODEX_HOME=... codex login` produces):
//   {
//     "auth_mode": "chatgpt",
//     "OPENAI_API_KEY": null,
//     "tokens": {
//       "id_token":      "<JWT>",
//       "access_token":  "<JWT>",
//       "refresh_token": "<opaque string>",
//       "account_id":    "<uuid>"
//     },
//     "last_refresh": "<ISO 8601>"
//   }
//
// We deliberately preserve unknown fields on write so codex CLI can keep
// using the same file without losing data.

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export const DEFAULT_CODEX_OAUTH_HOME_BASENAME = "codex-oauth-home";

/** Absolute path to the auth.json file given a codexHome directory. */
export function authJsonPath(codexHome: string): string {
  return path.join(codexHome, "auth.json");
}

/** Resolve the codexHome directory for this adapter.
 *
 * Priority: explicit arg > env CODEX_OAUTH_HOME > ~/.paperclip/codex-oauth-home
 */
export function resolveCodexOAuthHome(override?: string | null | undefined): string {
  const explicit = typeof override === "string" ? override.trim() : "";
  if (explicit) return path.isAbsolute(explicit) ? explicit : path.resolve(explicit);
  const envHome = (process.env.CODEX_OAUTH_HOME ?? "").trim();
  if (envHome) return path.isAbsolute(envHome) ? envHome : path.resolve(envHome);
  return path.join(os.homedir(), ".paperclip", DEFAULT_CODEX_OAUTH_HOME_BASENAME);
}

export interface CodexOAuthTokens {
  id_token?: string;
  access_token: string;
  refresh_token: string;
  account_id?: string;
}

export interface CodexOAuthAuthFile {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens: CodexOAuthTokens;
  last_refresh?: string;
  // Preserve any other fields codex CLI may add in the future.
  [extra: string]: unknown;
}

export class CodexOAuthStoreError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "auth_file_missing"
      | "auth_file_unreadable"
      | "auth_file_invalid_json"
      | "auth_file_missing_tokens"
      | "auth_file_write_failed",
  ) {
    super(message);
    this.name = "CodexOAuthStoreError";
  }
}

/** Read auth.json from the given codexHome.
 *
 * Throws CodexOAuthStoreError with a stable code so callers can render
 * actionable error messages (e.g. "run `CODEX_HOME=<dir> codex login`").
 */
export async function readAuthFile(codexHome: string): Promise<CodexOAuthAuthFile> {
  const filePath = authJsonPath(codexHome);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException).code;
    if (errno === "ENOENT") {
      throw new CodexOAuthStoreError(
        `Codex OAuth auth.json not found at ${filePath}. Run \`CODEX_HOME=${codexHome} codex login\` to create it.`,
        "auth_file_missing",
      );
    }
    throw new CodexOAuthStoreError(
      `Failed to read ${filePath}: ${(err as Error).message}`,
      "auth_file_unreadable",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CodexOAuthStoreError(
      `Invalid JSON in ${filePath}: ${(err as Error).message}`,
      "auth_file_invalid_json",
    );
  }

  if (!isAuthFileShape(parsed)) {
    throw new CodexOAuthStoreError(
      `auth.json at ${filePath} is missing required tokens (access_token, refresh_token).`,
      "auth_file_missing_tokens",
    );
  }
  return parsed;
}

/** Write auth.json atomically (write to .tmp, then rename). */
export async function writeAuthFile(
  codexHome: string,
  next: CodexOAuthAuthFile,
): Promise<void> {
  await fs.mkdir(codexHome, { recursive: true });
  const finalPath = authJsonPath(codexHome);
  const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(tmpPath, JSON.stringify(next, null, 2), { mode: 0o600 });
    await fs.rename(tmpPath, finalPath);
  } catch (err) {
    // Best-effort cleanup of stale tmp.
    await fs.unlink(tmpPath).catch(() => {});
    throw new CodexOAuthStoreError(
      `Failed to write ${finalPath}: ${(err as Error).message}`,
      "auth_file_write_failed",
    );
  }
}

/** Update the in-memory auth file with new tokens (merging, preserving extras). */
export function withRefreshedTokens(
  prev: CodexOAuthAuthFile,
  refreshed: { access_token: string; refresh_token: string; id_token?: string },
): CodexOAuthAuthFile {
  return {
    ...prev,
    tokens: {
      ...prev.tokens,
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token,
      ...(refreshed.id_token ? { id_token: refreshed.id_token } : {}),
    },
    last_refresh: new Date().toISOString(),
  };
}

function isAuthFileShape(v: unknown): v is CodexOAuthAuthFile {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const tokens = (v as { tokens?: unknown }).tokens;
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) return false;
  const t = tokens as Record<string, unknown>;
  return typeof t.access_token === "string" && typeof t.refresh_token === "string";
}

/** Decode a JWT payload section (no signature verification — we just want claims). */
export function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  if (typeof jwt !== "string" || !jwt.includes(".")) return null;
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  let p = parts[1];
  const pad = p.length % 4;
  if (pad) p += "=".repeat(4 - pad);
  try {
    const decoded = Buffer.from(p, "base64").toString("utf8");
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Seconds until the access_token expires. Negative if already expired. null if no `exp` claim. */
export function accessTokenSecondsUntilExpiry(accessToken: string): number | null {
  const claims = decodeJwtPayload(accessToken);
  const exp = claims?.exp;
  if (typeof exp !== "number") return null;
  return exp - Math.floor(Date.now() / 1000);
}

/** Extract chatgpt-account-id from id_token claims (preferred) or fallback to tokens.account_id. */
export function resolveChatgptAccountId(auth: CodexOAuthAuthFile): string | null {
  const claims = decodeJwtPayload(auth.tokens.id_token ?? "");
  const oai = claims?.["https://api.openai.com/auth"];
  if (oai && typeof oai === "object" && !Array.isArray(oai)) {
    const accId = (oai as Record<string, unknown>).chatgpt_account_id;
    if (typeof accId === "string" && accId.length > 0) return accId;
  }
  if (typeof auth.tokens.account_id === "string" && auth.tokens.account_id.length > 0) {
    return auth.tokens.account_id;
  }
  return null;
}
