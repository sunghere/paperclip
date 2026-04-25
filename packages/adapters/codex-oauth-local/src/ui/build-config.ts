// UI form → adapterConfig builder for codex_oauth_local.
//
// We expose minimal fields:
//   - model              (from CreateConfigValues.model)
//   - reasoningEffort    (from CreateConfigValues.thinkingEffort, mapped)
//   - codexHome          (from adapterSchemaValues.codexHome, optional)
//   - timeoutSec         (from adapterSchemaValues.timeoutSec, optional)
//   - instructionsFilePath (passthrough)
//
// We deliberately do NOT pull through `command`, `extraArgs`, `envVars`,
// `cwd`, `chrome`, `search`, `fastMode`, `dangerouslyBypassSandbox`,
// `workspaceStrategyType` etc. — none apply to a pure HTTP adapter.

import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { DEFAULT_CODEX_OAUTH_MODEL, isCodexOAuthKnownModel } from "../index.js";

export function buildCodexOAuthLocalConfig(v: CreateConfigValues): Record<string, unknown> {
  const config: Record<string, unknown> = {};

  // Model: keep the known list as a soft default; let user override but warn
  // (the actual rejection happens server-side at first call).
  const model = (v.model ?? "").trim();
  if (model) {
    config.model = model;
  } else {
    config.model = DEFAULT_CODEX_OAUTH_MODEL;
  }

  // Reasoning effort: map UI's "thinkingEffort" if present and non-default.
  const effort = (v.thinkingEffort ?? "").trim();
  if (effort) {
    config.reasoningEffort = effort;
  }

  // instructionsFilePath: passthrough only when set (matches codex-local).
  const instructions = (v.instructionsFilePath ?? "").trim();
  if (instructions) {
    config.instructionsFilePath = instructions;
  }

  // Schema-driven extras. The UI doesn't (yet) have a codex-oauth-local
  // schema panel, so we read from adapterSchemaValues if some future panel
  // sets these.
  const extras = v.adapterSchemaValues ?? {};

  const codexHome = readNonEmptyString(extras.codexHome);
  if (codexHome) config.codexHome = codexHome;

  const timeoutSec = readPositiveNumber(extras.timeoutSec);
  if (timeoutSec !== null) config.timeoutSec = timeoutSec;

  return config;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readNonEmptyString(v: unknown): string {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : "";
}

function readPositiveNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

// Re-exports so the UI registry can read constants alongside the builder.
export { DEFAULT_CODEX_OAUTH_MODEL, isCodexOAuthKnownModel };
