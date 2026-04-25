// codex_oauth_local does not spawn a CLI, so there is no stdout to parse.
// We export a no-op so the UI registry shape stays uniform with codex-local.
//
// Signature matches paperclip's UIAdapterModule.parseStdoutLine:
//   (line: string, ts: string) => TranscriptEntry[]

import type { TranscriptEntry } from "@paperclipai/adapter-utils";

export function parseCodexOAuthStdoutLine(_line: string, _ts: string): TranscriptEntry[] {
  return [];
}
