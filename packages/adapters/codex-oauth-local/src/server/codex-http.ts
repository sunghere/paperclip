// HTTP transport — calls https://chatgpt.com/backend-api/codex/responses with
// SSE accumulation, automatic token refresh, and one retry on 401.
//
// This is the only place that actually talks to the Codex backend. Everything
// else (execute, parse) is a thin shell on top.
//
// Verified shape (PoC, 2026-04):
//   - stream: true is REQUIRED — the backend rejects non-streaming requests.
//   - response.completed.output is ALWAYS an empty array; the real output
//     items come via response.output_item.done events. We accumulate them
//     in `output` below.
//   - tools must NOT have `strict: true` — the ChatGPT-account backend rejects it.
//   - The `originator` and `version` headers mimic codex_cli_rs to avoid
//     server-side allowlisting issues.

import {
  type CodexOAuthAuthFile,
  type CodexOAuthTokens,
  accessTokenSecondsUntilExpiry,
  readAuthFile,
  resolveChatgptAccountId,
  withRefreshedTokens,
  writeAuthFile,
} from "./oauth-store.js";
import {
  CodexOAuthRefreshError,
  refreshCodexOAuthTokens,
} from "./oauth-refresh.js";

export const CODEX_API_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const CODEX_RESPONSES_PATH = "/responses";
export const CODEX_REQUEST_ORIGINATOR = "codex_cli_rs";
export const CODEX_REQUEST_VERSION = "0.0.0";

/** Default skew before access_token expiry at which we proactively refresh. */
export const ACCESS_TOKEN_REFRESH_SKEW_SECONDS = 60;

// ---------------------------------------------------------------------------
// Public types — the surface that execute.ts consumes.
// ---------------------------------------------------------------------------

/** A single output item as observed via SSE response.output_item.done. */
export type CodexOutputItem =
  | { type: "message"; role?: string; content?: Array<Record<string, unknown>>; [extra: string]: unknown }
  | { type: "function_call"; name: string; arguments: string; call_id: string; [extra: string]: unknown }
  | { type: "reasoning"; encrypted_content?: string; summary?: unknown[]; content?: unknown[]; [extra: string]: unknown }
  | { type: string; [extra: string]: unknown };

/** Result of a single Responses API call. */
export interface CodexHttpCallResult {
  /** Output items reconstructed from streaming events (NOT response.completed.output). */
  output: CodexOutputItem[];
  /** Final assistant text accumulated from response.output_text.delta events. */
  text: string;
  /** Final response.status (e.g. "completed", "incomplete", "failed"). */
  status: string | null;
  /** Optional response.id for diagnostics. */
  responseId: string | null;
  /** Last seen reasoning summary text deltas (concatenated). */
  reasoningSummary: string;
}

export interface CodexResponsesRequestBody {
  model: string;
  instructions?: string;
  /** Already-shaped Responses-API input array (caller is responsible for shape). */
  input: unknown[];
  tools?: unknown[];
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  /** Reasoning options. Defaults to { effort: "medium", summary: "auto" } when omitted. */
  reasoning?: { effort?: string; summary?: string } | null;
  /** Extra include items (e.g. ["reasoning.encrypted_content"]). */
  include?: string[];
  /** Caller can pass-through anything else; kept open for forward compat. */
  [extra: string]: unknown;
}

export interface CodexHttpCallOptions {
  /** Path to codexHome (the directory containing auth.json). */
  codexHome: string;
  /** Per-call timeout. Default 600s. */
  timeoutMs?: number;
  /** AbortSignal for cancellation (e.g. run timeout / user cancel). */
  signal?: AbortSignal;
  /** Optional fetch override for tests. */
  fetchImpl?: typeof fetch;
  /** Hook called on every SSE event (parsed JSON). Useful for live progress. */
  onEvent?: (event: Record<string, unknown>) => void;
}

// ---------------------------------------------------------------------------
// Token resolution + refresh — called once per HTTP attempt.
// ---------------------------------------------------------------------------

interface ResolvedAuth {
  auth: CodexOAuthAuthFile;
  tokens: CodexOAuthTokens;
  accountId: string | null;
}

/**
 * Load auth.json. If access_token is within `skew` seconds of expiry,
 * refresh first and persist the rotated pair.
 */
async function loadAuthRefreshIfNeeded(codexHome: string): Promise<ResolvedAuth> {
  let auth = await readAuthFile(codexHome);
  const secsLeft = accessTokenSecondsUntilExpiry(auth.tokens.access_token);
  if (secsLeft !== null && secsLeft < ACCESS_TOKEN_REFRESH_SKEW_SECONDS) {
    auth = await refreshAndPersist(codexHome, auth);
  }
  return {
    auth,
    tokens: auth.tokens,
    accountId: resolveChatgptAccountId(auth),
  };
}

/** Force a refresh and write the new tokens back to disk. */
async function refreshAndPersist(
  codexHome: string,
  prev: CodexOAuthAuthFile,
): Promise<CodexOAuthAuthFile> {
  const refreshed = await refreshCodexOAuthTokens(prev.tokens.refresh_token);
  const next = withRefreshedTokens(prev, refreshed);
  await writeAuthFile(codexHome, next);
  return next;
}

// ---------------------------------------------------------------------------
// HTTP call with one retry on 401 (refresh and try again).
// ---------------------------------------------------------------------------

export class CodexHttpError extends Error {
  constructor(
    message: string,
    public readonly httpStatus?: number,
    public readonly bodyText?: string,
    public readonly retriable = false,
    public readonly reloginRequired = false,
  ) {
    super(message);
    this.name = "CodexHttpError";
  }
}

/** Execute one Responses API call, accumulate streamed output, return aggregated result. */
export async function callCodexResponses(
  body: CodexResponsesRequestBody,
  options: CodexHttpCallOptions,
): Promise<CodexHttpCallResult> {
  const { codexHome } = options;

  // First attempt — refresh proactively if expiry is near, then make the call.
  let resolved = await loadAuthRefreshIfNeeded(codexHome);

  try {
    return await streamOne(body, resolved, options);
  } catch (err) {
    if (err instanceof CodexHttpError && err.httpStatus === 401 && !err.reloginRequired) {
      // Force a refresh and retry once. If the auth server says the refresh
      // token is dead, propagate as relogin-required.
      try {
        const refreshedFile = await refreshAndPersist(codexHome, resolved.auth);
        resolved = {
          auth: refreshedFile,
          tokens: refreshedFile.tokens,
          accountId: resolveChatgptAccountId(refreshedFile),
        };
      } catch (refreshErr) {
        if (refreshErr instanceof CodexOAuthRefreshError) {
          throw new CodexHttpError(
            refreshErr.message,
            refreshErr.httpStatus,
            undefined,
            false,
            refreshErr.reloginRequired,
          );
        }
        throw refreshErr;
      }
      return await streamOne(body, resolved, options);
    }
    throw err;
  }
}

async function streamOne(
  body: CodexResponsesRequestBody,
  auth: ResolvedAuth,
  options: CodexHttpCallOptions,
): Promise<CodexHttpCallResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = Math.max(5_000, options.timeoutMs ?? 600_000);

  const internalCtl = new AbortController();
  const externalSignal = options.signal;
  const onAbort = () => internalCtl.abort(externalSignal?.reason);
  if (externalSignal) {
    if (externalSignal.aborted) onAbort();
    else externalSignal.addEventListener("abort", onAbort);
  }
  const timer = setTimeout(() => internalCtl.abort(new Error("codex_http_timeout")), timeoutMs);

  // Always-present knobs the backend mandates.
  const finalBody: CodexResponsesRequestBody = {
    ...body,
    stream: true,
    store: false,
  };
  if (finalBody.tool_choice === undefined) finalBody.tool_choice = "auto";
  if (finalBody.parallel_tool_calls === undefined) finalBody.parallel_tool_calls = true;

  const url = `${CODEX_API_BASE_URL}${CODEX_RESPONSES_PATH}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.tokens.access_token}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "OpenAI-Beta": "responses=v1",
    originator: CODEX_REQUEST_ORIGINATOR,
    version: CODEX_REQUEST_VERSION,
  };
  if (auth.accountId) headers["chatgpt-account-id"] = auth.accountId;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(finalBody),
      signal: internalCtl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener("abort", onAbort);
    const aborted = (err as Error)?.name === "AbortError";
    throw new CodexHttpError(
      aborted
        ? "Codex Responses request was aborted (timeout or cancellation)."
        : `Codex Responses request failed: ${(err as Error).message}`,
      undefined,
      undefined,
      !aborted,
    );
  }

  if (!response.ok) {
    const text = await safeReadBody(response);
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener("abort", onAbort);
    const status = response.status;
    const retriable = status >= 500 || status === 429;
    throw new CodexHttpError(
      `Codex Responses API returned ${status}: ${text || "(no body)"}`,
      status,
      text,
      retriable,
      false,
    );
  }
  if (!response.body) {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener("abort", onAbort);
    throw new CodexHttpError("Codex Responses API returned no response body.", response.status, undefined, true);
  }

  const result: CodexHttpCallResult = {
    output: [],
    text: "",
    status: null,
    responseId: null,
    reasoningSummary: "",
  };

  try {
    for await (const event of parseSseStream(response.body)) {
      options.onEvent?.(event);
      handleEvent(event, result);
    }
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener("abort", onAbort);
  }

  return result;
}

// ---------------------------------------------------------------------------
// SSE parsing — tiny zero-dep parser. Yields each `data: { ... }` JSON event.
// Exported for unit tests; not part of the package's public API surface.
// ---------------------------------------------------------------------------

export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncIterableIterator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE events end with a blank line (\n\n or \r\n\r\n).
      let idx: number;
      while ((idx = findEventBoundary(buffer)) >= 0) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx).replace(/^(?:\r?\n){1,2}/, "");
        const parsed = parseSseEvent(rawEvent);
        if (parsed) yield parsed;
      }
    }
    // Flush any trailing event without final blank line.
    const tail = buffer.trim();
    if (tail) {
      const parsed = parseSseEvent(tail);
      if (parsed) yield parsed;
    }
  } finally {
    reader.releaseLock();
  }
}

function findEventBoundary(buf: string): number {
  // Return the index of the FIRST char of the boundary (so slice(0, idx) is
  // the event content). Boundary is "\n\n" or "\r\n\r\n".
  const lf2 = buf.indexOf("\n\n");
  const crlf2 = buf.indexOf("\r\n\r\n");
  if (lf2 < 0 && crlf2 < 0) return -1;
  if (lf2 < 0) return crlf2;
  if (crlf2 < 0) return lf2;
  return Math.min(lf2, crlf2);
}

function parseSseEvent(raw: string): Record<string, unknown> | null {
  // We only care about `data:` lines. Each event may have multiple data: lines
  // (concatenate per SSE spec), or simply one.
  const lines = raw.split(/\r?\n/);
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
  }
  if (dataLines.length === 0) return null;
  const payload = dataLines.join("\n");
  if (payload === "[DONE]" || payload === "") return null;
  try {
    const obj = JSON.parse(payload);
    return obj && typeof obj === "object" ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Event handler — fold one parsed SSE event into the running result.
// Exported for unit tests; not part of the package's public API surface.
// ---------------------------------------------------------------------------

export function handleEvent(event: Record<string, unknown>, result: CodexHttpCallResult): void {
  const t = event.type;
  if (t === "response.created" || t === "response.in_progress") {
    const resp = event.response;
    if (resp && typeof resp === "object") {
      const id = (resp as Record<string, unknown>).id;
      if (typeof id === "string") result.responseId = id;
    }
    return;
  }
  if (t === "response.output_item.done") {
    const item = event.item;
    if (item && typeof item === "object") {
      result.output.push(item as CodexOutputItem);
    }
    return;
  }
  if (t === "response.output_text.delta") {
    const d = event.delta;
    if (typeof d === "string") result.text += d;
    return;
  }
  if (t === "response.reasoning_summary_text.delta") {
    const d = event.delta;
    if (typeof d === "string") result.reasoningSummary += d;
    return;
  }
  if (t === "response.completed") {
    const resp = event.response;
    if (resp && typeof resp === "object") {
      const status = (resp as Record<string, unknown>).status;
      if (typeof status === "string") result.status = status;
    }
    return;
  }
  // Other events (content_part.added/.done, output_text.done, output_item.added,
  // reasoning_summary_part.*, etc.) are intentionally ignored — they're
  // intermediate signals we don't need for paperclip's contract.
}

async function safeReadBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
