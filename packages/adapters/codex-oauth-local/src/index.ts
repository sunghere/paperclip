// Codex OAuth Local adapter — public surface (type/label/models/doc).
//
// Calls ChatGPT/Codex Responses API directly with an OAuth access token
// stored under a separate CODEX_HOME (default ~/.paperclip/codex-oauth-home).
// This bypasses the `codex` CLI binary entirely, so usage is independent
// from the main ~/.codex auth that codex_local adapter and the user's
// interactive `codex` command share.

export const type = "codex_oauth_local";
export const label = "Codex (OAuth, HTTP direct)";

// Models that are confirmed to work with a ChatGPT-account OAuth token
// against https://chatgpt.com/backend-api/codex/responses (verified via
// PoC, 2026-04). Platform API-key models (gpt-5, gpt-5-codex, gpt-5.2-codex
// etc.) are intentionally excluded — they return 400 with "not supported
// when using Codex with a ChatGPT account".
export const DEFAULT_CODEX_OAUTH_MODEL = "gpt-5.4-mini";

export const models = [
  { id: "gpt-5.5", label: "gpt-5.5" },
  { id: "gpt-5.4", label: "gpt-5.4" },
  { id: DEFAULT_CODEX_OAUTH_MODEL, label: DEFAULT_CODEX_OAUTH_MODEL },
  { id: "gpt-5.3-codex", label: "gpt-5.3-codex" },
];

export function isCodexOAuthKnownModel(model: string | null | undefined): boolean {
  const normalized = typeof model === "string" ? model.trim() : "";
  if (!normalized) return false;
  return models.some((m) => m.id === normalized);
}

export const agentConfigurationDoc = `# codex_oauth_local agent configuration

Adapter: codex_oauth_local

Calls the Codex Responses API at https://chatgpt.com/backend-api/codex/responses
directly over HTTP using an OAuth access token. The codex CLI binary is NOT
spawned — this adapter is independent of the main ~/.codex auth.

Core fields:
- model (string, optional): one of "gpt-5.5", "gpt-5.4", "gpt-5.4-mini",
  "gpt-5.3-codex". Other model IDs (gpt-5, gpt-5-codex, codex-mini-latest,
  gpt-5.2-codex, gpt-5.1-codex-*) are rejected by the backend when using a
  ChatGPT-account token.
- codexHome (string, optional): override the auth directory. Defaults to
  the env var CODEX_OAUTH_HOME, then to ~/.paperclip/codex-oauth-home.
  The directory must contain auth.json with valid OAuth tokens (typically
  produced by running \`CODEX_HOME=<that-dir> codex login\` once).
- reasoningEffort (string, optional): "minimal" | "low" | "medium" | "high"
  | "xhigh" — passed through to the Responses API \`reasoning.effort\` field.
  Defaults to "medium". Only meaningful for reasoning-capable models like
  gpt-5.3-codex.
- timeoutSec (number, optional): per-request timeout. Defaults to 600.

Operational notes:
- Access tokens are auto-refreshed when within 60 seconds of expiry. The
  refreshed access+refresh pair (the refresh token rotates on every call)
  is written back to <codexHome>/auth.json so the codex CLI in that home
  also sees the updated tokens.
- The backend mandates \`stream: true\` on every request; this adapter uses
  SSE accumulators internally and exposes a final result to Paperclip.
- Tool calls and function_call_output round-trips are supported. Reasoning
  items are echoed across turns to preserve the model's chain of thought.
- This adapter does not yet implement skills mounting, instructions bundles,
  or workspace runtimes — keep adapterConfig minimal.

Setup (one-time):
  1. Pick a directory for the OAuth home, e.g. ~/.paperclip/codex-oauth-home
  2. \`CODEX_HOME=~/.paperclip/codex-oauth-home codex login\`
     (use a private/incognito window if you want a different ChatGPT
     account from the one your main \`codex\` CLI uses)
  3. Verify <codexHome>/auth.json was created
  4. Configure the agent with \`adapterType: "codex_oauth_local"\` and (optionally)
     \`codexHome: "<absolute-path>"\` if not using the default
`;
