import { describe, it, expect } from "vitest";
import {
  extractFinalText,
  extractFunctionCalls,
  extractReasoningItems,
  classifyFinishStatus,
  summarizeResult,
} from "./parse.js";
import type { CodexHttpCallResult } from "./codex-http.js";

function makeResult(overrides: Partial<CodexHttpCallResult> = {}): CodexHttpCallResult {
  return {
    output: [],
    text: "",
    status: null,
    responseId: null,
    reasoningSummary: "",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe("extractFinalText", () => {
  it("returns result.text when present (the streaming-delta path)", () => {
    expect(extractFinalText(makeResult({ text: "hello" }))).toBe("hello");
  });

  it("falls back to message content[].text when result.text is empty", () => {
    const r = makeResult({
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "fallback" }],
        },
      ],
    });
    expect(extractFinalText(r)).toBe("fallback");
  });

  it("returns the FIRST text-bearing content part it finds", () => {
    const r = makeResult({
      output: [
        {
          type: "message",
          content: [{ type: "x" }, { type: "output_text", text: "first" }, { type: "output_text", text: "second" }],
        },
      ],
    });
    expect(extractFinalText(r)).toBe("first");
  });

  it("returns empty string when nothing matches", () => {
    expect(extractFinalText(makeResult())).toBe("");
  });

  it("ignores non-message items in the fallback search", () => {
    const r = makeResult({
      output: [{ type: "function_call", name: "f", arguments: "{}", call_id: "c" }],
    });
    expect(extractFinalText(r)).toBe("");
  });
});

// ---------------------------------------------------------------------------

describe("extractFunctionCalls", () => {
  it("returns function_call items in stream order", () => {
    const r = makeResult({
      output: [
        { type: "message", content: [] },
        { type: "function_call", name: "f1", arguments: "{}", call_id: "c1" },
        { type: "reasoning" },
        { type: "function_call", name: "f2", arguments: "{\"a\":1}", call_id: "c2" },
      ],
    });
    expect(extractFunctionCalls(r)).toEqual([
      { name: "f1", arguments: "{}", call_id: "c1" },
      { name: "f2", arguments: '{"a":1}', call_id: "c2" },
    ]);
  });

  it("includes responseItemId when item has an id", () => {
    const r = makeResult({
      output: [{ type: "function_call", name: "f", arguments: "{}", call_id: "c", id: "item-1" }],
    });
    expect(extractFunctionCalls(r)[0]).toEqual({
      name: "f",
      arguments: "{}",
      call_id: "c",
      responseItemId: "item-1",
    });
  });

  it("defaults arguments to {} when missing or non-string", () => {
    const r = makeResult({
      output: [{ type: "function_call", name: "f", arguments: undefined as unknown as string, call_id: "c" }],
    });
    expect(extractFunctionCalls(r)[0].arguments).toBe("{}");
  });

  it("skips items missing name or call_id (avoids feeding garbage downstream)", () => {
    const r = makeResult({
      output: [
        { type: "function_call", name: "", arguments: "{}", call_id: "c1" },
        { type: "function_call", name: "f", arguments: "{}", call_id: "" },
        { type: "function_call", name: "good", arguments: "{}", call_id: "c2" },
      ],
    });
    expect(extractFunctionCalls(r).map((c) => c.name)).toEqual(["good"]);
  });

  it("returns empty array when no function_calls present", () => {
    expect(extractFunctionCalls(makeResult())).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("extractReasoningItems", () => {
  it("filters items by type === 'reasoning'", () => {
    const r = makeResult({
      output: [
        { type: "reasoning", encrypted_content: "abc" },
        { type: "message", content: [] },
        { type: "reasoning", encrypted_content: "def" },
      ],
    });
    const items = extractReasoningItems(r);
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.type === "reasoning")).toBe(true);
  });

  it("preserves encrypted_content (must be echoed in next-turn input)", () => {
    const r = makeResult({
      output: [{ type: "reasoning", encrypted_content: "secret-blob" }],
    });
    expect((extractReasoningItems(r)[0] as Record<string, unknown>).encrypted_content).toBe("secret-blob");
  });
});

// ---------------------------------------------------------------------------

describe("classifyFinishStatus", () => {
  it("'completed' → 'stop'", () => {
    expect(classifyFinishStatus("completed")).toBe("stop");
  });
  it("'incomplete' → 'length' (treated as truncation)", () => {
    expect(classifyFinishStatus("incomplete")).toBe("length");
  });
  it("'failed' → 'fail'", () => {
    expect(classifyFinishStatus("failed")).toBe("fail");
  });
  it("null → 'fail'", () => {
    expect(classifyFinishStatus(null)).toBe("fail");
  });
  it("unknown string → 'fail' (forward compat default)", () => {
    expect(classifyFinishStatus("zaphod")).toBe("fail");
  });
});

// ---------------------------------------------------------------------------

describe("summarizeResult", () => {
  it("emits status= when nothing else present", () => {
    expect(summarizeResult(makeResult({ status: "completed" }))).toBe("status=completed");
  });

  it("includes counts of messages, tool_calls, reasoning when present", () => {
    const r = makeResult({
      status: "completed",
      output: [
        { type: "message", content: [] },
        { type: "function_call", name: "f", arguments: "{}", call_id: "c" },
        { type: "function_call", name: "f2", arguments: "{}", call_id: "c2" },
        { type: "reasoning" },
      ],
      text: "hi",
    });
    const s = summarizeResult(r);
    expect(s).toContain("status=completed");
    expect(s).toContain("messages=1");
    expect(s).toContain("tool_calls=2");
    expect(s).toContain("reasoning=1");
    expect(s).toContain("text_len=2");
  });

  it("uses '?' when status is null", () => {
    expect(summarizeResult(makeResult())).toBe("status=?");
  });

  it("omits zero-count parts (no 'tool_calls=0' noise)", () => {
    const s = summarizeResult(makeResult({ status: "completed" }));
    expect(s).not.toContain("messages=");
    expect(s).not.toContain("tool_calls=");
    expect(s).not.toContain("reasoning=");
  });
});
