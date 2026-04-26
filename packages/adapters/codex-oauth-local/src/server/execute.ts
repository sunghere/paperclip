// Adapter execute() entry point — implements the AdapterExecutionContext contract.
//
// Design choices:
//   - Single HTTP turn per execute() call. Paperclip drives the heartbeat
//     loop externally, so we don't multiplex turns inside one invocation.
//   - No git worktree, no skills mounting, no codex_home preparation, no
//     bypass-approval handling. Those are codex-local concerns; this
//     adapter is a thin OAuth-only path.
//   - All HTTP/SSE work is delegated to codex-http.ts. We only adapt the
//     paperclip-shaped input/output around it.

import fs from "node:fs/promises";
import {
  inferOpenAiCompatibleBiller,
  type AdapterExecutionContext,
  type AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_CODEX_OAUTH_MODEL } from "../index.js";
import {
  callCodexResponses,
  CodexHttpError,
  type CodexResponsesRequestBody,
} from "./codex-http.js";
import { resolveCodexOAuthHome } from "./oauth-store.js";
import {
  classifyFinishStatus,
  extractFinalText,
  extractFunctionCalls,
  summarizeResult,
} from "./parse.js";

/** Adapter contract entry point — wired into server/src/adapters/registry.ts. */
export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { agent, runtime, config, context, onLog, onMeta } = ctx;

  // 1. Resolve adapter config -------------------------------------------------
  const model = readNonEmptyString(config.model) || DEFAULT_CODEX_OAUTH_MODEL;
  const codexHome = resolveCodexOAuthHome(readNonEmptyString(config.codexHome));
  const reasoningEffort = readNonEmptyString(config.reasoningEffort) || "medium";
  const timeoutSec = readPositiveNumber(config.timeoutSec) ?? 600;

  // 2. Build the prompt -------------------------------------------------------
  // System prompt: instructionsFilePath if provided, else fall back to a tiny default.
  const instructionsFile = readNonEmptyString(config.instructionsFilePath);
  let instructions = "";
  if (instructionsFile) {
    try {
      instructions = (await fs.readFile(instructionsFile, "utf8")).trim();
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] codex_oauth_local: could not read instructionsFilePath ${instructionsFile}: ${(err as Error).message}\n`,
      );
    }
  }
  if (!instructions) {
    instructions = "You are a Paperclip agent. Take concrete action when the assigned issue is actionable.";
  }

  // User message: paperclip wake payload rendered as markdown, falling back to
  // a minimal heartbeat hint if nothing was provided.
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, {
    resumedSession: Boolean(runtime.sessionId),
  });
  const userText = wakePrompt.trim().length > 0
    ? wakePrompt
    : "## Paperclip heartbeat\n\nNo wake payload provided. Pick up the next assigned issue and report progress.";

  // 3. Build the Responses API request body ----------------------------------
  const body: CodexResponsesRequestBody = {
    model,
    instructions,
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: userText }],
      },
    ],
    tools: [],
    tool_choice: "auto",
    parallel_tool_calls: true,
    reasoning: { effort: reasoningEffort, summary: "auto" },
    include: ["reasoning.encrypted_content"],
  };

  // 4. Emit invocation meta for the run log ----------------------------------
  if (onMeta) {
    await onMeta({
      adapterType: "codex_oauth_local",
      command: "(http)",
      commandArgs: ["POST", `${codexHome}/auth.json → chatgpt.com/backend-api/codex/responses`],
      env: { CODEX_OAUTH_HOME: codexHome },
      prompt: userText,
      promptMetrics: {
        instructionsLength: instructions.length,
        userPromptLength: userText.length,
      },
      context: {
        agentId: agent.id,
        companyId: agent.companyId,
        runtimeSessionId: runtime.sessionId ?? null,
        model,
      },
    });
  }

  await onLog(
    "stdout",
    `[paperclip] codex_oauth_local: model=${model} effort=${reasoningEffort} codexHome=${codexHome}\n`,
  );

  // 5. Make the HTTP call -----------------------------------------------------
  let result: Awaited<ReturnType<typeof callCodexResponses>>;
  try {
    result = await callCodexResponses(body, {
      codexHome,
      timeoutMs: timeoutSec * 1000,
      onEvent: (event) => {
        // Forward streaming text deltas to the log so users see partial output.
        if (event.type === "response.output_text.delta") {
          const d = event.delta;
          if (typeof d === "string" && d.length > 0) {
            // Fire-and-forget — we don't await per delta to keep streaming fast.
            // onLog is async but we tolerate the unawaited promise here.
            void onLog("stdout", d);
          }
        }
      },
    });
  } catch (err) {
    return errorToResult(err, model);
  }

  // 6. Shape the AdapterExecutionResult --------------------------------------
  const finalText = extractFinalText(result);
  const finishKind = classifyFinishStatus(result.status);
  const funcCalls = extractFunctionCalls(result);

  await onLog(
    "stdout",
    `\n[paperclip] codex_oauth_local: ${summarizeResult(result)}\n`,
  );

  // Sessionless adapter — paperclip stores no resumable session state on our side.
  // The Responses API store=false means no server-side conversation either.
  return {
    exitCode: finishKind === "stop" || finishKind === "length" ? 0 : 1,
    signal: null,
    timedOut: false,
    errorMessage: finishKind === "stop" || finishKind === "length" ? null : `Codex run finished with status=${result.status}`,
    sessionId: null,
    sessionParams: null,
    sessionDisplayId: result.responseId,
    provider: "openai",
    biller: inferOpenAiCompatibleBiller({}, "openai") ?? "openai",
    model,
    billingType: "subscription",
    costUsd: null,
    summary: finalText.length > 0 ? finalText : null,
    resultJson: {
      result: finalText,
      response_id: result.responseId,
      status: result.status,
      finish: finishKind,
      output_items: result.output.length,
      function_calls: funcCalls.map((c) => ({ name: c.name, call_id: c.call_id })),
      reasoning_summary: result.reasoningSummary || null,
    },
    clearSession: false,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function errorToResult(err: unknown, model: string): AdapterExecutionResult {
  if (err instanceof CodexHttpError) {
    const transient = err.retriable && !err.reloginRequired;
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: err.message,
      errorCode: err.reloginRequired ? "codex_oauth_relogin_required" : transient ? "codex_oauth_transient" : "codex_oauth_failed",
      errorFamily: transient ? "transient_upstream" : null,
      provider: "openai",
      biller: "openai",
      model,
      billingType: "subscription",
      costUsd: null,
      resultJson: {
        http_status: err.httpStatus ?? null,
        body: err.bodyText ?? null,
        relogin_required: err.reloginRequired,
      },
      clearSession: false,
    };
  }
  const message = (err as Error)?.message || String(err);
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorMessage: `codex_oauth_local internal error: ${message}`,
    errorCode: "codex_oauth_internal_error",
    provider: "openai",
    biller: "openai",
    model,
    billingType: "subscription",
    costUsd: null,
    resultJson: {
      message,
    },
    clearSession: false,
  };
}

function readNonEmptyString(v: unknown): string {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : "";
}

function readPositiveNumber(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
  return v;
}
