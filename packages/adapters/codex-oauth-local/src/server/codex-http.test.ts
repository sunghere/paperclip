import { describe, it, expect, vi } from "vitest";
import {
  parseSseStream,
  handleEvent,
  callCodexResponses,
  CodexHttpError,
  CODEX_API_BASE_URL,
  CODEX_RESPONSES_PATH,
  type CodexHttpCallResult,
} from "./codex-http.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

async function collect(stream: ReadableStream<Uint8Array>): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for await (const ev of parseSseStream(stream)) out.push(ev);
  return out;
}

function emptyResult(): CodexHttpCallResult {
  return { output: [], text: "", status: null, responseId: null, reasoningSummary: "" };
}

// ---------------------------------------------------------------------------
// parseSseStream — wire format parsing
// ---------------------------------------------------------------------------

describe("parseSseStream", () => {
  it("parses a single complete event terminated by \\n\\n", async () => {
    const sse = `event: response.created\ndata: {"type":"response.created","response":{"id":"r-1"}}\n\n`;
    const events = await collect(makeStream([sse]));
    expect(events).toEqual([
      { type: "response.created", response: { id: "r-1" } },
    ]);
  });

  it("parses CRLF-terminated events", async () => {
    const sse = `data: {"type":"a"}\r\n\r\ndata: {"type":"b"}\r\n\r\n`;
    const events = await collect(makeStream([sse]));
    expect(events.map((e) => e.type)).toEqual(["a", "b"]);
  });

  it("parses events split across multiple chunks (mid-event)", async () => {
    // Split the JSON payload right in the middle.
    const events = await collect(
      makeStream([`data: {"type":"resp`, `onse.completed","response":{"status":"completed"}}\n\n`]),
    );
    expect(events).toEqual([
      { type: "response.completed", response: { status: "completed" } },
    ]);
  });

  it("parses multiple events arriving in one chunk", async () => {
    const sse = `data: {"type":"a"}\n\ndata: {"type":"b"}\n\ndata: {"type":"c"}\n\n`;
    const events = await collect(makeStream([sse]));
    expect(events.map((e) => e.type)).toEqual(["a", "b", "c"]);
  });

  it("ignores [DONE] sentinels", async () => {
    const sse = `data: {"type":"x"}\n\ndata: [DONE]\n\n`;
    const events = await collect(makeStream([sse]));
    expect(events.map((e) => e.type)).toEqual(["x"]);
  });

  it("ignores comment lines (event:, id:, retry:) and emits only data:", async () => {
    const sse = `event: response.created\nid: 1\nretry: 1000\ndata: {"type":"hello"}\n\n`;
    const events = await collect(makeStream([sse]));
    expect(events).toEqual([{ type: "hello" }]);
  });

  it("flushes a trailing event without final blank line", async () => {
    const sse = `data: {"type":"trailing"}`;
    const events = await collect(makeStream([sse]));
    expect(events).toEqual([{ type: "trailing" }]);
  });

  it("skips events with malformed JSON without throwing", async () => {
    const sse = `data: not-json\n\ndata: {"type":"good"}\n\n`;
    const events = await collect(makeStream([sse]));
    expect(events).toEqual([{ type: "good" }]);
  });

  it("concatenates multi-line data: payloads (SSE spec)", async () => {
    const sse = `data: {"type":\ndata: "two-line"}\n\n`;
    const events = await collect(makeStream([sse]));
    expect(events).toEqual([{ type: "two-line" }]);
  });
});

// ---------------------------------------------------------------------------
// handleEvent — accumulator semantics
// THIS IS THE CRITICAL TEST: response.completed.output is ALWAYS empty,
// items must come from response.output_item.done.
// ---------------------------------------------------------------------------

describe("handleEvent — output accumulation", () => {
  it("collects items from response.output_item.done (the canonical source)", () => {
    const result = emptyResult();
    handleEvent(
      {
        type: "response.output_item.done",
        item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] },
      },
      result,
    );
    expect(result.output).toHaveLength(1);
    expect(result.output[0]).toMatchObject({ type: "message" });
  });

  it("does NOT trust response.completed.output (it is always empty in ChatGPT backend)", () => {
    const result = emptyResult();
    // Real items arrive via output_item.done.
    handleEvent(
      { type: "response.output_item.done", item: { type: "message", content: [] } },
      result,
    );
    // response.completed arrives with output=[] but we must not clobber.
    handleEvent(
      { type: "response.completed", response: { status: "completed", output: [] } },
      result,
    );
    expect(result.output).toHaveLength(1);
    expect(result.status).toBe("completed");
  });

  it("collects function_call and reasoning items alongside messages", () => {
    const result = emptyResult();
    handleEvent(
      { type: "response.output_item.done", item: { type: "reasoning", encrypted_content: "x" } },
      result,
    );
    handleEvent(
      {
        type: "response.output_item.done",
        item: { type: "function_call", name: "f", arguments: "{}", call_id: "c1" },
      },
      result,
    );
    handleEvent(
      { type: "response.output_item.done", item: { type: "message", content: [] } },
      result,
    );
    expect(result.output.map((i) => i.type)).toEqual(["reasoning", "function_call", "message"]);
  });

  it("ignores response.output_item.done events with a non-object item", () => {
    const result = emptyResult();
    handleEvent({ type: "response.output_item.done", item: null }, result);
    handleEvent({ type: "response.output_item.done", item: "string-item" }, result);
    expect(result.output).toEqual([]);
  });
});

describe("handleEvent — text + reasoning deltas", () => {
  it("accumulates text from response.output_text.delta", () => {
    const result = emptyResult();
    handleEvent({ type: "response.output_text.delta", delta: "hel" }, result);
    handleEvent({ type: "response.output_text.delta", delta: "lo" }, result);
    expect(result.text).toBe("hello");
  });

  it("accumulates reasoning summary from response.reasoning_summary_text.delta", () => {
    const result = emptyResult();
    handleEvent({ type: "response.reasoning_summary_text.delta", delta: "step1 " }, result);
    handleEvent({ type: "response.reasoning_summary_text.delta", delta: "step2" }, result);
    expect(result.reasoningSummary).toBe("step1 step2");
  });

  it("ignores delta events whose delta is not a string", () => {
    const result = emptyResult();
    handleEvent({ type: "response.output_text.delta", delta: 42 }, result);
    expect(result.text).toBe("");
  });
});

describe("handleEvent — metadata", () => {
  it("captures response.id from response.created", () => {
    const result = emptyResult();
    handleEvent({ type: "response.created", response: { id: "r-abc" } }, result);
    expect(result.responseId).toBe("r-abc");
  });

  it("captures status from response.completed", () => {
    const result = emptyResult();
    handleEvent({ type: "response.completed", response: { status: "incomplete" } }, result);
    expect(result.status).toBe("incomplete");
  });

  it("ignores unknown event types silently (forward compat)", () => {
    const result = emptyResult();
    handleEvent({ type: "response.never_heard_of_this" }, result);
    expect(result).toEqual(emptyResult());
  });
});

// ---------------------------------------------------------------------------
// callCodexResponses — integration over a fake fetch
// ---------------------------------------------------------------------------

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Build a JWT-shaped string with the given payload. Used to feed a
 *  long-lived access_token expiry so the proactive-refresh path stays cold. */
function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

async function makeAuthHome(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-http-test-"));
  const exp = Math.floor(Date.now() / 1000) + 3600; // 1h ahead
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

function makeResponse(body: string, status = 200): Response {
  // Wrap the body as a streaming response.
  const stream = makeStream([body]);
  return new Response(stream, {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

const MINIMAL_SSE = [
  `data: {"type":"response.created","response":{"id":"r-1"}}\n\n`,
  `data: {"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":"hi"}]}}\n\n`,
  `data: {"type":"response.output_text.delta","delta":"hi"}\n\n`,
  `data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n`,
].join("");

describe("callCodexResponses — happy path", () => {
  it("issues a single POST with required headers and returns accumulated result", async () => {
    const codexHome = await makeAuthHome();
    try {
      const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => makeResponse(MINIMAL_SSE));
      const result = await callCodexResponses(
        { model: "gpt-5.5", input: [{ role: "user", content: "hi" }] },
        { codexHome, fetchImpl: fetchImpl as unknown as typeof fetch },
      );

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImpl.mock.calls[0];
      expect(url).toBe(`${CODEX_API_BASE_URL}${CODEX_RESPONSES_PATH}`);
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers["Authorization"]).toMatch(/^Bearer /);
      expect(headers["chatgpt-account-id"]).toBe("acc-1");
      expect(headers["originator"]).toBe("codex_cli_rs");
      expect(headers["OpenAI-Beta"]).toBe("responses=v1");

      // Body must include stream:true and store:false, both backend-mandated.
      const body = JSON.parse(String((init as RequestInit).body));
      expect(body.stream).toBe(true);
      expect(body.store).toBe(false);
      expect(body.tool_choice).toBe("auto");

      // Result is reconstructed from output_item.done, not response.completed.output.
      expect(result.output).toHaveLength(1);
      expect(result.text).toBe("hi");
      expect(result.status).toBe("completed");
      expect(result.responseId).toBe("r-1");
    } finally {
      await fs.rm(codexHome, { recursive: true, force: true });
    }
  });

  it("invokes onEvent for every parsed SSE event", async () => {
    const codexHome = await makeAuthHome();
    try {
      const onEvent = vi.fn();
      const fetchImpl = vi.fn(async () => makeResponse(MINIMAL_SSE));
      await callCodexResponses(
        { model: "gpt-5.5", input: [] },
        { codexHome, fetchImpl: fetchImpl as unknown as typeof fetch, onEvent },
      );
      const types = onEvent.mock.calls.map((c) => (c[0] as Record<string, unknown>).type);
      expect(types).toEqual([
        "response.created",
        "response.output_item.done",
        "response.output_text.delta",
        "response.completed",
      ]);
    } finally {
      await fs.rm(codexHome, { recursive: true, force: true });
    }
  });
});

describe("callCodexResponses — error paths", () => {
  it("throws CodexHttpError with httpStatus when API returns 4xx (non-401)", async () => {
    const codexHome = await makeAuthHome();
    try {
      const fetchImpl = vi.fn(async () => new Response("bad request", { status: 400 }));
      await expect(
        callCodexResponses(
          { model: "gpt-5.5", input: [] },
          { codexHome, fetchImpl: fetchImpl as unknown as typeof fetch },
        ),
      ).rejects.toMatchObject({
        name: "CodexHttpError",
        httpStatus: 400,
        retriable: false,
      });
    } finally {
      await fs.rm(codexHome, { recursive: true, force: true });
    }
  });

  it("marks 5xx errors as retriable", async () => {
    const codexHome = await makeAuthHome();
    try {
      const fetchImpl = vi.fn(async () => new Response("boom", { status: 503 }));
      await expect(
        callCodexResponses(
          { model: "gpt-5.5", input: [] },
          { codexHome, fetchImpl: fetchImpl as unknown as typeof fetch },
        ),
      ).rejects.toMatchObject({ httpStatus: 503, retriable: true });
    } finally {
      await fs.rm(codexHome, { recursive: true, force: true });
    }
  });

  it("marks 429 as retriable", async () => {
    const codexHome = await makeAuthHome();
    try {
      const fetchImpl = vi.fn(async () => new Response("rate", { status: 429 }));
      await expect(
        callCodexResponses(
          { model: "gpt-5.5", input: [] },
          { codexHome, fetchImpl: fetchImpl as unknown as typeof fetch },
        ),
      ).rejects.toMatchObject({ httpStatus: 429, retriable: true });
    } finally {
      await fs.rm(codexHome, { recursive: true, force: true });
    }
  });
});

describe("CodexHttpError", () => {
  it("carries httpStatus, bodyText, retriable, reloginRequired", () => {
    const err = new CodexHttpError("x", 401, "unauthorized", false, true);
    expect(err.httpStatus).toBe(401);
    expect(err.bodyText).toBe("unauthorized");
    expect(err.reloginRequired).toBe(true);
    expect(err).toBeInstanceOf(Error);
  });
});
