import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  authJsonPath,
  resolveCodexOAuthHome,
  readAuthFile,
  writeAuthFile,
  withRefreshedTokens,
  decodeJwtPayload,
  accessTokenSecondsUntilExpiry,
  resolveChatgptAccountId,
  CodexOAuthStoreError,
  type CodexOAuthAuthFile,
} from "./oauth-store.js";

// --- Fixture helpers --------------------------------------------------------

/** Build a JWT-shaped string with the given payload object. Signature is a placeholder. */
function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature-placeholder`;
}

const VALID_AUTH: CodexOAuthAuthFile = {
  auth_mode: "chatgpt",
  OPENAI_API_KEY: null,
  tokens: {
    id_token: makeJwt({ sub: "user-test", "https://api.openai.com/auth": { chatgpt_account_id: "acc-from-jwt" } }),
    access_token: "access-aaa",
    refresh_token: "refresh-bbb",
    account_id: "acc-fallback",
  },
  last_refresh: "2025-01-01T00:00:00.000Z",
};

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-oauth-store-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// --- authJsonPath / resolveCodexOAuthHome ----------------------------------

describe("authJsonPath", () => {
  it("joins codexHome with auth.json", () => {
    expect(authJsonPath("/tmp/foo")).toBe(path.join("/tmp/foo", "auth.json"));
  });
});

describe("resolveCodexOAuthHome", () => {
  const ORIGINAL_ENV = process.env.CODEX_OAUTH_HOME;
  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.CODEX_OAUTH_HOME;
    else process.env.CODEX_OAUTH_HOME = ORIGINAL_ENV;
  });

  it("returns the override when given an absolute path", () => {
    expect(resolveCodexOAuthHome("/abs/path")).toBe("/abs/path");
  });

  it("resolves a relative override against cwd", () => {
    const out = resolveCodexOAuthHome("./rel-path");
    expect(path.isAbsolute(out)).toBe(true);
    expect(out.endsWith("rel-path")).toBe(true);
  });

  it("falls back to CODEX_OAUTH_HOME env when override is empty", () => {
    process.env.CODEX_OAUTH_HOME = "/from/env";
    expect(resolveCodexOAuthHome()).toBe("/from/env");
    expect(resolveCodexOAuthHome("")).toBe("/from/env");
  });

  it("falls back to ~/.paperclip/codex-oauth-home when no env and no override", () => {
    delete process.env.CODEX_OAUTH_HOME;
    const out = resolveCodexOAuthHome();
    expect(out).toBe(path.join(os.homedir(), ".paperclip", "codex-oauth-home"));
  });
});

// --- readAuthFile -----------------------------------------------------------

describe("readAuthFile", () => {
  it("reads and parses a valid auth.json", async () => {
    await fs.writeFile(path.join(tmpDir, "auth.json"), JSON.stringify(VALID_AUTH));
    const got = await readAuthFile(tmpDir);
    expect(got.tokens.access_token).toBe("access-aaa");
    expect(got.tokens.refresh_token).toBe("refresh-bbb");
  });

  it("preserves unknown extra fields (codex CLI forward-compat)", async () => {
    const withExtras = { ...VALID_AUTH, future_field: { custom: 42 } };
    await fs.writeFile(path.join(tmpDir, "auth.json"), JSON.stringify(withExtras));
    const got = await readAuthFile(tmpDir);
    expect(got["future_field"]).toEqual({ custom: 42 });
  });

  it("throws auth_file_missing when auth.json does not exist", async () => {
    await expect(readAuthFile(tmpDir)).rejects.toMatchObject({
      name: "CodexOAuthStoreError",
      code: "auth_file_missing",
    });
  });

  it("throws auth_file_invalid_json on malformed JSON", async () => {
    await fs.writeFile(path.join(tmpDir, "auth.json"), "{not json");
    await expect(readAuthFile(tmpDir)).rejects.toMatchObject({
      code: "auth_file_invalid_json",
    });
  });

  it("throws auth_file_missing_tokens when tokens object is missing", async () => {
    await fs.writeFile(path.join(tmpDir, "auth.json"), JSON.stringify({ auth_mode: "chatgpt" }));
    await expect(readAuthFile(tmpDir)).rejects.toMatchObject({
      code: "auth_file_missing_tokens",
    });
  });

  it("throws auth_file_missing_tokens when access_token is missing", async () => {
    await fs.writeFile(
      path.join(tmpDir, "auth.json"),
      JSON.stringify({ tokens: { refresh_token: "r" } }),
    );
    await expect(readAuthFile(tmpDir)).rejects.toMatchObject({
      code: "auth_file_missing_tokens",
    });
  });
});

// --- writeAuthFile ----------------------------------------------------------

describe("writeAuthFile", () => {
  it("writes the file atomically and round-trips through readAuthFile", async () => {
    await writeAuthFile(tmpDir, VALID_AUTH);
    const got = await readAuthFile(tmpDir);
    expect(got.tokens.access_token).toBe(VALID_AUTH.tokens.access_token);
  });

  it("creates the codexHome dir if missing", async () => {
    const nested = path.join(tmpDir, "nested", "deep");
    await writeAuthFile(nested, VALID_AUTH);
    const got = await readAuthFile(nested);
    expect(got.tokens.refresh_token).toBe("refresh-bbb");
  });

  it("does not leave a .tmp file behind on success", async () => {
    await writeAuthFile(tmpDir, VALID_AUTH);
    const entries = await fs.readdir(tmpDir);
    expect(entries.filter((e) => e.includes(".tmp-"))).toEqual([]);
  });
});

// --- withRefreshedTokens ----------------------------------------------------

describe("withRefreshedTokens", () => {
  it("rotates access_token and refresh_token", () => {
    const next = withRefreshedTokens(VALID_AUTH, {
      access_token: "new-access",
      refresh_token: "new-refresh",
    });
    expect(next.tokens.access_token).toBe("new-access");
    expect(next.tokens.refresh_token).toBe("new-refresh");
  });

  it("updates id_token when provided", () => {
    const next = withRefreshedTokens(VALID_AUTH, {
      access_token: "a",
      refresh_token: "r",
      id_token: "new-id",
    });
    expect(next.tokens.id_token).toBe("new-id");
  });

  it("preserves the previous id_token when not provided", () => {
    const next = withRefreshedTokens(VALID_AUTH, { access_token: "a", refresh_token: "r" });
    expect(next.tokens.id_token).toBe(VALID_AUTH.tokens.id_token);
  });

  it("preserves extra top-level fields", () => {
    const withExtras: CodexOAuthAuthFile = { ...VALID_AUTH, custom_field: "kept" };
    const next = withRefreshedTokens(withExtras, { access_token: "a", refresh_token: "r" });
    expect(next["custom_field"]).toBe("kept");
  });

  it("updates last_refresh to a fresh ISO timestamp", () => {
    const before = Date.now();
    const next = withRefreshedTokens(VALID_AUTH, { access_token: "a", refresh_token: "r" });
    const stamp = Date.parse(next.last_refresh ?? "");
    expect(stamp).toBeGreaterThanOrEqual(before);
  });
});

// --- decodeJwtPayload -------------------------------------------------------

describe("decodeJwtPayload", () => {
  it("decodes the payload of a well-formed JWT", () => {
    const jwt = makeJwt({ sub: "user-x", custom: 1 });
    expect(decodeJwtPayload(jwt)).toEqual({ sub: "user-x", custom: 1 });
  });

  it("returns null for non-string input", () => {
    expect(decodeJwtPayload(undefined as unknown as string)).toBeNull();
  });

  it("returns null when there are no dots", () => {
    expect(decodeJwtPayload("not-a-jwt")).toBeNull();
  });

  it("returns null when payload is not valid JSON", () => {
    const bad = "header." + Buffer.from("not-json", "utf8").toString("base64url") + ".sig";
    expect(decodeJwtPayload(bad)).toBeNull();
  });

  it("handles base64 padding correctly", () => {
    // Force a payload length that requires padding.
    const jwt = makeJwt({ a: 1 }); // {"a":1} -> 7 chars -> base64url stripped padding
    expect(decodeJwtPayload(jwt)).toEqual({ a: 1 });
  });
});

// --- accessTokenSecondsUntilExpiry -----------------------------------------

describe("accessTokenSecondsUntilExpiry", () => {
  it("returns positive seconds for a future exp", () => {
    const future = Math.floor(Date.now() / 1000) + 600;
    const jwt = makeJwt({ exp: future });
    const got = accessTokenSecondsUntilExpiry(jwt);
    expect(got).not.toBeNull();
    expect(got!).toBeGreaterThan(590);
    expect(got!).toBeLessThanOrEqual(600);
  });

  it("returns negative seconds for a past exp", () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const jwt = makeJwt({ exp: past });
    expect(accessTokenSecondsUntilExpiry(jwt)!).toBeLessThan(0);
  });

  it("returns null when there is no exp claim", () => {
    const jwt = makeJwt({ sub: "u" });
    expect(accessTokenSecondsUntilExpiry(jwt)).toBeNull();
  });

  it("returns null for an undecodable token", () => {
    expect(accessTokenSecondsUntilExpiry("garbage")).toBeNull();
  });
});

// --- resolveChatgptAccountId ------------------------------------------------

describe("resolveChatgptAccountId", () => {
  it("prefers chatgpt_account_id from id_token claims", () => {
    expect(resolveChatgptAccountId(VALID_AUTH)).toBe("acc-from-jwt");
  });

  it("falls back to tokens.account_id when id_token has no claim", () => {
    const auth: CodexOAuthAuthFile = {
      ...VALID_AUTH,
      tokens: { ...VALID_AUTH.tokens, id_token: makeJwt({ sub: "u" }) },
    };
    expect(resolveChatgptAccountId(auth)).toBe("acc-fallback");
  });

  it("falls back to tokens.account_id when id_token is missing", () => {
    const auth: CodexOAuthAuthFile = {
      ...VALID_AUTH,
      tokens: {
        access_token: "a",
        refresh_token: "r",
        account_id: "acc-only-fallback",
      },
    };
    expect(resolveChatgptAccountId(auth)).toBe("acc-only-fallback");
  });

  it("returns null when nothing is available", () => {
    const auth: CodexOAuthAuthFile = {
      tokens: { access_token: "a", refresh_token: "r" },
    };
    expect(resolveChatgptAccountId(auth)).toBeNull();
  });
});

// --- Sanity: CodexOAuthStoreError instance --------------------------------

describe("CodexOAuthStoreError", () => {
  it("carries the code field for callers to switch on", () => {
    const err = new CodexOAuthStoreError("x", "auth_file_missing");
    expect(err.code).toBe("auth_file_missing");
    expect(err).toBeInstanceOf(Error);
  });
});
