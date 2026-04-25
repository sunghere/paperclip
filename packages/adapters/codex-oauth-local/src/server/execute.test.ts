import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionContext, AdapterInvocationMeta } from "@paperclipai/adapter-utils";
import { execute } from "./execute.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

async function makeAuthHome(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-oauth-execute-test-"));
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const auth = {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: makeJwt({ sub: "u", "https://api.openai.com/auth": { chatgpt_account_id: "acc-1" } }),
      access_token: makeJwt({ exp }),
      refresh_token: "refresh-xyz",
      account_id: "acc-1",
    },
  };
  await fs.writeFile(path.join(dir, "auth.json"), JSON.stringify(auth));
  return dir;
}

function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(enc.encode(chunks[i++]));
    },
  });
}

function sseResponse(body: string, status = 200): Response {
  return new Response(makeStream([body]), {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

const SUCCESS_SSE = [
  `data: {"type":"response.created","response":{"id":"r-test"}}\n\n`,
  `data: {"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":"hello"}]}}\n\n`,
  `data: {"type":"response.output_text.delta","delta":"hello"}\n\n`,
  `data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n`,
].join("");

const SSE_WITH_FUNCTION_CALL = [
  `data: {"type":"response.created","response":{"id":"r-fc"}}\n\n`,
  `data: {"type":"response.output_item.done","item":{"type":"function_call","name":"my_tool","arguments":"{\\"a\\":1}","call_id":"call-1"}}\n\n`,
  `data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n`,
].join("");

function buildContext(opts: {
  codexHome: string;
  configOverrides?: Record<string, unknown>;
}): AdapterExecutionContext & {
  capturedLogs: Array<[string, string]>;
  capturedMeta: AdapterInvocationMeta[];
} {
  const capturedLogs: Array<[string, string]> = [];
  const capturedMeta: AdapterInvocationMeta[] = [];
  const ctx: AdapterExecutionContext = {
    runId: "run-test",
    agent: {
      id: "agent-1",
      companyId: "co-1",
      name: "test-agent",
      adapterType: "codex_oauth_local",
      adapterConfig: null,
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      model: "gpt-5.5",
      codexHome: opts.codexHome,
      ...opts.configOverrides,
    },
    context: {},
    onLog: async (stream, chunk) => {
      capturedLogs.push([stream, chunk]);
    },
    onMeta: async (meta) => {
      capturedMeta.push(meta);
    },
  };
  return Object.assign(ctx, { capturedLogs, capturedMeta });
}

// ---------------------------------------------------------------------------
// fetch mocking — we install a spy on globalThis.fetch per-test
// ---------------------------------------------------------------------------

let fetchSpy: ReturnType<typeof vi.spyOn> | null = null;
let codexHome: string | null = null;

beforeEach(async () => {
  codexHome = await makeAuthHome();
});

afterEach(async () => {
  if (fetchSpy) {
    fetchSpy.mockRestore();
    fetchSpy = null;
  }
  if (codexHome) {
    await fs.rm(codexHome, { recursive: true, force: true });
    codexHome = null;
  }
});

function installFetchMock(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  // Cast through unknown because vi.spyOn's signature for fetch doesn't compose
  // cleanly with our narrowed (url, init) impl signature.
  fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(impl as unknown as typeof globalThis.fetch) as unknown as ReturnType<
    typeof vi.spyOn
  >;
  return fetchSpy;
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("execute — happy path", () => {
  it("returns exitCode=0, status='stop', summary=text on a completed response", async () => {
    installFetchMock(async () => sseResponse(SUCCESS_SSE));
    const ctx = buildContext({ codexHome: codexHome! });

    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.errorMessage).toBeNull();
    expect(result.summary).toBe("hello");
    expect(result.model).toBe("gpt-5.5");
    expect(result.provider).toBe("openai");
    expect(result.billingType).toBe("subscription");
    expect(result.sessionDisplayId).toBe("r-test");
    expect((result.resultJson as Record<string, unknown>).finish).toBe("stop");
  });

  it("emits onMeta with adapterType, env.CODEX_OAUTH_HOME, and prompt metrics", async () => {
    installFetchMock(async () => sseResponse(SUCCESS_SSE));
    const ctx = buildContext({ codexHome: codexHome! });

    await execute(ctx);

    expect(ctx.capturedMeta).toHaveLength(1);
    const meta = ctx.capturedMeta[0];
    expect(meta.adapterType).toBe("codex_oauth_local");
    expect(meta.env).toMatchObject({ CODEX_OAUTH_HOME: codexHome });
    expect(meta.promptMetrics).toBeDefined();
    expect((meta.promptMetrics as Record<string, number>).userPromptLength).toBeGreaterThan(0);
  });

  it("forwards streaming text deltas to onLog as they arrive", async () => {
    installFetchMock(async () => sseResponse(SUCCESS_SSE));
    const ctx = buildContext({ codexHome: codexHome! });

    await execute(ctx);

    const stdoutLogs = ctx.capturedLogs.filter(([s]) => s === "stdout").map(([, c]) => c);
    // The "hello" delta should show up as its own log chunk.
    expect(stdoutLogs.some((chunk) => chunk === "hello")).toBe(true);
    // And the summary line should be appended at the end.
    expect(stdoutLogs.some((chunk) => chunk.includes("status=completed"))).toBe(true);
  });

  it("captures function_calls in resultJson", async () => {
    installFetchMock(async () => sseResponse(SSE_WITH_FUNCTION_CALL));
    const ctx = buildContext({ codexHome: codexHome! });

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);
    const calls = (result.resultJson as Record<string, unknown>).function_calls as Array<{
      name: string;
      call_id: string;
    }>;
    expect(calls).toEqual([{ name: "my_tool", call_id: "call-1" }]);
  });
});

// ---------------------------------------------------------------------------
// Config defaults
// ---------------------------------------------------------------------------

describe("execute — config handling", () => {
  it("falls back to DEFAULT_CODEX_OAUTH_MODEL when config.model is empty", async () => {
    let observedBody: Record<string, unknown> | null = null;
    installFetchMock(async (_url, init) => {
      observedBody = JSON.parse(String(init?.body));
      return sseResponse(SUCCESS_SSE);
    });
    const ctx = buildContext({ codexHome: codexHome!, configOverrides: { model: "" } });

    const result = await execute(ctx);

    expect(result.model).not.toBe("");
    expect(observedBody!.model).not.toBe("");
    // Default should be a non-empty string (the actual value lives in ../index.ts).
    expect(typeof observedBody!.model).toBe("string");
  });

  it("respects reasoningEffort override in the request body", async () => {
    let observedBody: Record<string, unknown> | null = null;
    installFetchMock(async (_url, init) => {
      observedBody = JSON.parse(String(init?.body));
      return sseResponse(SUCCESS_SSE);
    });
    const ctx = buildContext({
      codexHome: codexHome!,
      configOverrides: { reasoningEffort: "high" },
    });

    await execute(ctx);
    expect((observedBody!.reasoning as Record<string, unknown>).effort).toBe("high");
  });

  it("includes 'reasoning.encrypted_content' in the include array (round-trip requirement)", async () => {
    let observedBody: Record<string, unknown> | null = null;
    installFetchMock(async (_url, init) => {
      observedBody = JSON.parse(String(init?.body));
      return sseResponse(SUCCESS_SSE);
    });
    const ctx = buildContext({ codexHome: codexHome! });
    await execute(ctx);
    expect(observedBody!.include).toContain("reasoning.encrypted_content");
  });

  it("logs a warning when instructionsFilePath cannot be read but still proceeds", async () => {
    installFetchMock(async () => sseResponse(SUCCESS_SSE));
    const ctx = buildContext({
      codexHome: codexHome!,
      configOverrides: { instructionsFilePath: "/no/such/file/anywhere" },
    });

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);
    const stderrLogs = ctx.capturedLogs.filter(([s]) => s === "stderr").map(([, c]) => c);
    expect(stderrLogs.some((c) => c.includes("could not read instructionsFilePath"))).toBe(true);
  });

  it("reads instructionsFilePath when present and includes the body in the request", async () => {
    const instructionsPath = path.join(codexHome!, "system.md");
    await fs.writeFile(instructionsPath, "Be helpful and concise.");
    let observedBody: Record<string, unknown> | null = null;
    installFetchMock(async (_url, init) => {
      observedBody = JSON.parse(String(init?.body));
      return sseResponse(SUCCESS_SSE);
    });
    const ctx = buildContext({
      codexHome: codexHome!,
      configOverrides: { instructionsFilePath: instructionsPath },
    });

    await execute(ctx);
    expect(observedBody!.instructions).toBe("Be helpful and concise.");
  });
});

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

describe("execute — error → AdapterExecutionResult mapping", () => {
  it("returns exitCode=1 with errorCode='codex_oauth_failed' on a 400", async () => {
    installFetchMock(async () => new Response("bad", { status: 400 }));
    const ctx = buildContext({ codexHome: codexHome! });

    const result = await execute(ctx);

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("codex_oauth_failed");
    expect(result.errorMessage).toMatch(/400/);
    expect((result.resultJson as Record<string, unknown>).http_status).toBe(400);
  });

  it("returns errorFamily='transient_upstream' on a 503", async () => {
    installFetchMock(async () => new Response("boom", { status: 503 }));
    const ctx = buildContext({ codexHome: codexHome! });

    const result = await execute(ctx);

    expect(result.errorCode).toBe("codex_oauth_transient");
    expect(result.errorFamily).toBe("transient_upstream");
  });

  it("returns errorCode='codex_oauth_internal_error' when auth.json is missing", async () => {
    // Remove the file we just wrote to simulate a missing-auth scenario.
    await fs.unlink(path.join(codexHome!, "auth.json"));
    installFetchMock(async () => sseResponse(SUCCESS_SSE)); // never called
    const ctx = buildContext({ codexHome: codexHome! });

    const result = await execute(ctx);

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("codex_oauth_internal_error");
    expect(result.errorMessage).toMatch(/auth\.json/);
  });

  it("clearSession is always false (sessionless adapter)", async () => {
    installFetchMock(async () => sseResponse(SUCCESS_SSE));
    const ctx = buildContext({ codexHome: codexHome! });
    const result = await execute(ctx);
    expect(result.clearSession).toBe(false);
  });
});
