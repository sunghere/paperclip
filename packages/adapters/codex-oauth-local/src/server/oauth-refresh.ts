// OAuth token refresh — exchanges a refresh_token for a fresh access+refresh pair.
//
// Verified against the public OpenAI auth endpoint as used by the Codex CLI:
//   POST https://auth.openai.com/oauth/token
//   Content-Type: application/x-www-form-urlencoded
//   body: grant_type=refresh_token&refresh_token=<...>&client_id=<...>
//
// Behavior:
//   - 200 → returns { access_token, refresh_token, id_token? }; both tokens
//     ROTATE on every successful refresh, so the caller MUST persist the
//     new pair (see oauth-store.withRefreshedTokens + writeAuthFile).
//   - 401/403 or `invalid_grant`/`refresh_token_invalidated`/`refresh_token_reused`
//     → throws CodexOAuthRefreshError with reloginRequired=true. The user
//     must re-run `CODEX_HOME=<dir> codex login`.
//   - Network/timeout failures → reloginRequired=false (transient).

// PUBLIC values — these are not secrets. The Codex CLI ships the same client_id
// in its open-source Rust binary; ChatGPT-account OAuth tokens are bound to
// the user, not to the client id.
export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";

export interface CodexOAuthRefreshResult {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  /** Seconds until access_token expiry as reported by the auth server. */
  expires_in?: number;
}

export class CodexOAuthRefreshError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly reloginRequired: boolean,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "CodexOAuthRefreshError";
  }
}

interface RefreshOptions {
  timeoutMs?: number;
  /** Optional fetch override for tests. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

/** Exchange a refresh_token for a fresh access+refresh pair. */
export async function refreshCodexOAuthTokens(
  refreshToken: string,
  options: RefreshOptions = {},
): Promise<CodexOAuthRefreshResult> {
  if (typeof refreshToken !== "string" || refreshToken.trim().length === 0) {
    throw new CodexOAuthRefreshError(
      "Codex OAuth refresh_token is missing or empty.",
      "missing_refresh_token",
      true,
    );
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CODEX_OAUTH_CLIENT_ID,
  });

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = Math.max(2000, options.timeoutMs ?? 20_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(CODEX_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
      signal: controller.signal,
    });
  } catch (err) {
    const message =
      (err as Error)?.name === "AbortError"
        ? `Codex OAuth refresh timed out after ${timeoutMs}ms.`
        : `Codex OAuth refresh failed: ${(err as Error).message}`;
    throw new CodexOAuthRefreshError(message, "network_error", false);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    let bodyJson: unknown = null;
    try {
      bodyJson = await response.json();
    } catch {
      /* ignore */
    }
    const errCode = readErrorCode(bodyJson);
    const errDesc = readErrorDescription(bodyJson);
    const reloginRequired = isReloginRequiredErrorCode(errCode, response.status);
    const human = errDesc
      ? `Codex OAuth refresh failed (${response.status}): ${errDesc}`
      : `Codex OAuth refresh failed (${response.status}).`;
    throw new CodexOAuthRefreshError(
      human,
      errCode || `http_${response.status}`,
      reloginRequired,
      response.status,
    );
  }

  let payload: Record<string, unknown>;
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch (err) {
    throw new CodexOAuthRefreshError(
      `Codex OAuth refresh returned invalid JSON: ${(err as Error).message}`,
      "invalid_json",
      true,
    );
  }

  const access = readNonEmptyString(payload.access_token);
  const refresh = readNonEmptyString(payload.refresh_token);
  if (!access) {
    throw new CodexOAuthRefreshError(
      "Codex OAuth refresh response was missing access_token.",
      "missing_access_token",
      true,
    );
  }
  if (!refresh) {
    // Shouldn't happen — the auth server always rotates — but guard anyway.
    throw new CodexOAuthRefreshError(
      "Codex OAuth refresh response was missing refresh_token (unexpected).",
      "missing_refresh_token_in_response",
      true,
    );
  }

  const id = readNonEmptyString(payload.id_token);
  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : undefined;

  return {
    access_token: access,
    refresh_token: refresh,
    ...(id ? { id_token: id } : {}),
    ...(expiresIn !== undefined ? { expires_in: expiresIn } : {}),
  };
}

function isReloginRequiredErrorCode(code: string, status: number): boolean {
  if (status === 401 || status === 403) return true;
  if (
    code === "invalid_grant" ||
    code === "invalid_token" ||
    code === "invalid_request" ||
    code === "refresh_token_invalidated" ||
    code === "refresh_token_reused"
  ) {
    return true;
  }
  return false;
}

function readErrorCode(body: unknown): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "";
  const direct = (body as Record<string, unknown>).error;
  if (typeof direct === "string") return direct;
  // OpenAI sometimes wraps as `{ error: { code, message, type } }`.
  if (direct && typeof direct === "object" && !Array.isArray(direct)) {
    const inner = (direct as Record<string, unknown>).code;
    if (typeof inner === "string") return inner;
  }
  return "";
}

function readErrorDescription(body: unknown): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "";
  const r = body as Record<string, unknown>;
  if (typeof r.error_description === "string") return r.error_description;
  if (typeof r.message === "string") return r.message;
  const direct = r.error;
  if (direct && typeof direct === "object" && !Array.isArray(direct)) {
    const m = (direct as Record<string, unknown>).message;
    if (typeof m === "string") return m;
  }
  return "";
}

function readNonEmptyString(v: unknown): string {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : "";
}
