import { describe, it, expect, vi } from "vitest";
import {
  refreshCodexOAuthTokens,
  CodexOAuthRefreshError,
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_TOKEN_URL,
} from "./oauth-refresh.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("refreshCodexOAuthTokens — happy path", () => {
  it("POSTs form-encoded body to the auth endpoint with grant_type and client_id", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({
        access_token: "new-access",
        refresh_token: "new-refresh",
        id_token: "new-id",
        expires_in: 1800,
      }),
    );

    const result = await refreshCodexOAuthTokens("old-refresh", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(CODEX_OAUTH_TOKEN_URL);
    expect((init as RequestInit).method).toBe("POST");

    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");

    const params = new URLSearchParams(String((init as RequestInit).body));
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("old-refresh");
    expect(params.get("client_id")).toBe(CODEX_OAUTH_CLIENT_ID);

    expect(result.access_token).toBe("new-access");
    expect(result.refresh_token).toBe("new-refresh");
    expect(result.id_token).toBe("new-id");
    expect(result.expires_in).toBe(1800);
  });

  it("omits id_token from result when the server didn't return one", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ access_token: "a", refresh_token: "r" }),
    );
    const result = await refreshCodexOAuthTokens("old", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ access_token: "a", refresh_token: "r" });
    expect(result).not.toHaveProperty("id_token");
  });
});

// ---------------------------------------------------------------------------
// Empty / missing refresh_token guard (catches caller bugs early)
// ---------------------------------------------------------------------------

describe("refreshCodexOAuthTokens — input guards", () => {
  it("throws missing_refresh_token without making a network call", async () => {
    const fetchImpl = vi.fn();
    await expect(
      refreshCodexOAuthTokens("", { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ code: "missing_refresh_token", reloginRequired: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("treats whitespace-only refresh_token as missing", async () => {
    await expect(
      refreshCodexOAuthTokens("   "),
    ).rejects.toMatchObject({ code: "missing_refresh_token" });
  });
});

// ---------------------------------------------------------------------------
// Error classification — the part that decides whether to relogin or retry
// ---------------------------------------------------------------------------

describe("refreshCodexOAuthTokens — relogin-required errors", () => {
  it.each([
    ["invalid_grant", 400],
    ["refresh_token_invalidated", 400],
    ["refresh_token_reused", 400],
    ["invalid_token", 400],
  ])("classifies error code %s as reloginRequired", async (code, status) => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: code, error_description: "no" }, status),
    );
    await expect(
      refreshCodexOAuthTokens("old", { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ reloginRequired: true, httpStatus: status, code });
  });

  it("classifies HTTP 401 as reloginRequired regardless of error code", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "anything", error_description: "x" }, 401),
    );
    await expect(
      refreshCodexOAuthTokens("old", { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ reloginRequired: true, httpStatus: 401 });
  });

  it("classifies HTTP 403 as reloginRequired", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 403 }));
    await expect(
      refreshCodexOAuthTokens("old", { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ reloginRequired: true, httpStatus: 403 });
  });

  it("classifies HTTP 500 with no error code as NOT reloginRequired (server bug, retriable)", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 500 }));
    await expect(
      refreshCodexOAuthTokens("old", { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ reloginRequired: false, httpStatus: 500 });
  });

  it("reads error code from nested { error: { code } } shape (OpenAI variant)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { code: "invalid_grant", message: "no" } }, 400),
    );
    await expect(
      refreshCodexOAuthTokens("old", { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ code: "invalid_grant", reloginRequired: true });
  });
});

// ---------------------------------------------------------------------------
// Network / parse failures
// ---------------------------------------------------------------------------

describe("refreshCodexOAuthTokens — transport failures", () => {
  it("classifies fetch rejection as network_error (transient, NOT reloginRequired)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    await expect(
      refreshCodexOAuthTokens("old", { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ code: "network_error", reloginRequired: false });
  });

  it("rejects with invalid_json when response body cannot be parsed", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("not json", { status: 200, headers: { "content-type": "application/json" } }),
    );
    await expect(
      refreshCodexOAuthTokens("old", { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ code: "invalid_json", reloginRequired: true });
  });
});

// ---------------------------------------------------------------------------
// Response shape validation
// ---------------------------------------------------------------------------

describe("refreshCodexOAuthTokens — response validation", () => {
  it("rejects when access_token is missing", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ refresh_token: "r" }));
    await expect(
      refreshCodexOAuthTokens("old", { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ code: "missing_access_token" });
  });

  it("rejects when refresh_token is missing (must rotate)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ access_token: "a" }));
    await expect(
      refreshCodexOAuthTokens("old", { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ code: "missing_refresh_token_in_response" });
  });

  it("rejects when access_token is empty string", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ access_token: "   ", refresh_token: "r" }),
    );
    await expect(
      refreshCodexOAuthTokens("old", { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ code: "missing_access_token" });
  });
});

// ---------------------------------------------------------------------------

describe("CodexOAuthRefreshError", () => {
  it("carries code, reloginRequired, httpStatus", () => {
    const err = new CodexOAuthRefreshError("x", "invalid_grant", true, 400);
    expect(err.code).toBe("invalid_grant");
    expect(err.reloginRequired).toBe(true);
    expect(err.httpStatus).toBe(400);
    expect(err).toBeInstanceOf(Error);
  });
});
