// Lightweight helpers for classifying Codex HTTP errors and extracting the
// final assistant message text from an accumulated CodexHttpCallResult.
//
// We deliberately keep this small — most of the parse work happens in
// codex-http.ts (SSE accumulator). Things that belong here are paperclip-
// specific shaping decisions that don't rely on HTTP details.

import type { CodexHttpCallResult, CodexOutputItem } from "./codex-http.js";

/** Final assistant message text — joined from output_text deltas. */
export function extractFinalText(result: CodexHttpCallResult): string {
  if (result.text && result.text.length > 0) return result.text;
  // Fallback: if for some reason text deltas were empty, look for a message item.
  for (const item of result.output) {
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c && typeof c === "object" && "text" in c && typeof c.text === "string") {
          return c.text;
        }
      }
    }
  }
  return "";
}

/** Pick out function_call items in stream order. */
export function extractFunctionCalls(result: CodexHttpCallResult): Array<{
  name: string;
  arguments: string;
  call_id: string;
  responseItemId?: string;
}> {
  const calls: Array<{ name: string; arguments: string; call_id: string; responseItemId?: string }> = [];
  for (const item of result.output) {
    if (item.type !== "function_call") continue;
    const name = typeof item.name === "string" ? item.name : "";
    const args = typeof item.arguments === "string" ? item.arguments : "{}";
    const callId = typeof item.call_id === "string" ? item.call_id : "";
    if (!name || !callId) continue;
    const id = typeof item.id === "string" ? item.id : undefined;
    calls.push({ name, arguments: args, call_id: callId, ...(id ? { responseItemId: id } : {}) });
  }
  return calls;
}

/** Pick out reasoning items so callers can echo them in the next turn input. */
export function extractReasoningItems(result: CodexHttpCallResult): CodexOutputItem[] {
  return result.output.filter((it) => it.type === "reasoning");
}

/** Map response.status → paperclip-friendly outcome. */
export function classifyFinishStatus(status: string | null): "stop" | "length" | "fail" {
  if (status === "completed") return "stop";
  if (status === "incomplete") return "length";
  return "fail";
}

/** Pretty summary of an accumulated result for paperclip log lines. */
export function summarizeResult(result: CodexHttpCallResult): string {
  const fnCount = result.output.filter((i) => i.type === "function_call").length;
  const reasoningCount = result.output.filter((i) => i.type === "reasoning").length;
  const messageCount = result.output.filter((i) => i.type === "message").length;
  const parts: string[] = [];
  parts.push(`status=${result.status ?? "?"}`);
  if (messageCount) parts.push(`messages=${messageCount}`);
  if (fnCount) parts.push(`tool_calls=${fnCount}`);
  if (reasoningCount) parts.push(`reasoning=${reasoningCount}`);
  if (result.text) parts.push(`text_len=${result.text.length}`);
  return parts.join(" ");
}
