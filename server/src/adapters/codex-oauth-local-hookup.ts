// Fork-local hookup for the codex_oauth_local adapter.
//
// Why this file exists:
//   The fork's policy (see paperclip's AGENTS.md and the broader fork strategy)
//   is to minimize edits to upstream-owned files. New behavior should live in
//   fork-local helper modules; upstream files get at most a thin one-line call
//   to bring them in.
//
//   `registry.ts` is upstream-owned. Without this helper we'd need ~6 lines of
//   imports and a 12-line ServerAdapterModule literal in registry.ts itself.
//   By putting them here, registry.ts only needs:
//
//     import { codexOAuthLocalAdapter } from "./codex-oauth-local-hookup.js";
//     // ... and one line inside the registration loop:
//     codexOAuthLocalAdapter,
//
//   That's 2 lines vs 18+, and they're clearly fork-local additions that
//   are easy to keep across upstream merges.

import {
  execute as codexOAuthExecute,
  testEnvironment as codexOAuthTestEnvironment,
} from "@paperclipai/adapter-codex-oauth-local/server";
import {
  agentConfigurationDoc as codexOAuthAgentConfigurationDoc,
  models as codexOAuthModels,
} from "@paperclipai/adapter-codex-oauth-local";
import type { ServerAdapterModule } from "./types.js";

/** Server adapter module for the fork-local codex_oauth_local adapter. */
export const codexOAuthLocalAdapter: ServerAdapterModule = {
  type: "codex_oauth_local",
  execute: codexOAuthExecute,
  testEnvironment: codexOAuthTestEnvironment,
  // No skills sync — adapter does not mount skill files anywhere.
  // No sessionCodec — Responses API is sessionless (store=false).
  models: codexOAuthModels,
  supportsLocalAgentJwt: false,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: false,
  agentConfigurationDoc: codexOAuthAgentConfigurationDoc,
};
