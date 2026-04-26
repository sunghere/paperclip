// Minimal config UI for codex_oauth_local. Two fields: instructionsFilePath
// (passthrough) and codexHome (optional override of OAuth credentials directory).
//
// Following the pi-local minimal pattern. Model selection is driven by
// the parent adapter dropdown (which reads `models` from our package's
// src/index.ts), so we don't need to render a model picker here.

import type { AdapterConfigFieldsProps } from "../types";
import { Field, DraftInput } from "../../components/agent-config-primitives";
import { ChoosePathButton } from "../../components/PathInstructionsModal";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

const instructionsFileHint =
  "Absolute path to a markdown file (e.g. AGENTS.md) that defines this agent's behavior. Injected into the Responses API instructions field at runtime.";

const codexHomeHint =
  "Optional. Directory containing auth.json with OAuth tokens (created by `CODEX_HOME=<dir> codex login`). Defaults to ~/.paperclip/codex-oauth-home, falling back to env var CODEX_OAUTH_HOME.";

export function CodexOAuthLocalConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
  hideInstructionsFile,
}: AdapterConfigFieldsProps) {
  return (
    <>
      {!hideInstructionsFile && (
        <Field label="Agent instructions file" hint={instructionsFileHint}>
          <div className="flex items-center gap-2">
            <DraftInput
              value={
                isCreate
                  ? values!.instructionsFilePath ?? ""
                  : eff(
                      "adapterConfig",
                      "instructionsFilePath",
                      String(config.instructionsFilePath ?? ""),
                    )
              }
              onCommit={(v) =>
                isCreate
                  ? set!({ instructionsFilePath: v })
                  : mark("adapterConfig", "instructionsFilePath", v || undefined)
              }
              immediate
              className={inputClass}
              placeholder="/absolute/path/to/AGENTS.md"
            />
            <ChoosePathButton />
          </div>
        </Field>
      )}
      <Field label="Codex OAuth home directory" hint={codexHomeHint}>
        <DraftInput
          value={
            isCreate
              ? String((values!.adapterSchemaValues?.codexHome ?? ""))
              : eff(
                  "adapterConfig",
                  "codexHome",
                  String(config.codexHome ?? ""),
                )
          }
          onCommit={(v) => {
            const trimmed = v.trim();
            if (isCreate) {
              const prev = values!.adapterSchemaValues ?? {};
              set!({
                adapterSchemaValues: trimmed
                  ? { ...prev, codexHome: trimmed }
                  : Object.fromEntries(
                      Object.entries(prev).filter(([k]) => k !== "codexHome"),
                    ),
              });
            } else {
              mark("adapterConfig", "codexHome", trimmed || undefined);
            }
          }}
          immediate
          className={inputClass}
          placeholder="~/.paperclip/codex-oauth-home"
        />
      </Field>
    </>
  );
}
