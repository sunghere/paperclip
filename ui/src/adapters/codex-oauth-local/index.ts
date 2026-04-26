// UI adapter module for codex_oauth_local.
// Mirror of codex-local/index.ts but using @paperclipai/adapter-codex-oauth-local/ui.

import type { UIAdapterModule } from "../types";
import { parseCodexOAuthStdoutLine, buildCodexOAuthLocalConfig } from "@paperclipai/adapter-codex-oauth-local/ui";
import { CodexOAuthLocalConfigFields } from "./config-fields";

export const codexOAuthLocalUIAdapter: UIAdapterModule = {
  type: "codex_oauth_local",
  label: "Codex (OAuth, HTTP)",
  parseStdoutLine: parseCodexOAuthStdoutLine,
  ConfigFields: CodexOAuthLocalConfigFields,
  buildAdapterConfig: buildCodexOAuthLocalConfig,
};
