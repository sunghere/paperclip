// Lightweight environment check — verifies that auth.json exists, parses, and
// has tokens that look valid (refresh_token present + access_token JWT decodable).
//
// We deliberately do NOT make an actual API call here. testEnvironment runs
// at config save time and we don't want to burn quota on every save. If the
// user wants to verify the call path, the first run will surface 401/relogin.

import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { models, isCodexOAuthKnownModel } from "../index.js";
import {
  accessTokenSecondsUntilExpiry,
  CodexOAuthStoreError,
  readAuthFile,
  resolveChatgptAccountId,
  resolveCodexOAuthHome,
} from "./oauth-store.js";

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = ctx.config ?? {};

  const codexHome = resolveCodexOAuthHome(typeof config.codexHome === "string" ? config.codexHome : null);
  checks.push({
    code: "codex_oauth_home",
    level: "info",
    message: `Using codexHome: ${codexHome}`,
  });

  let auth;
  try {
    auth = await readAuthFile(codexHome);
  } catch (err) {
    if (err instanceof CodexOAuthStoreError) {
      checks.push({
        code: err.code,
        level: "error",
        message: err.message,
        hint: err.code === "auth_file_missing"
          ? `Run \`CODEX_HOME=${codexHome} codex login\` to create auth.json.`
          : null,
      });
      return finalize(ctx, checks);
    }
    checks.push({
      code: "auth_file_unreadable",
      level: "error",
      message: `Failed to read auth.json: ${(err as Error).message}`,
    });
    return finalize(ctx, checks);
  }

  // auth_mode hint
  const authMode = typeof auth.auth_mode === "string" ? auth.auth_mode : null;
  if (authMode === "chatgpt") {
    checks.push({ code: "auth_mode", level: "info", message: "auth_mode=chatgpt (ChatGPT account OAuth)" });
  } else if (authMode === "apikey") {
    checks.push({
      code: "auth_mode",
      level: "warn",
      message: "auth_mode=apikey detected — this adapter is designed for ChatGPT-account OAuth.",
      hint: `Re-run \`CODEX_HOME=${codexHome} codex login\` and pick the ChatGPT account flow.`,
    });
  }

  // refresh_token shape
  if (!auth.tokens.refresh_token || auth.tokens.refresh_token.trim().length === 0) {
    checks.push({
      code: "missing_refresh_token",
      level: "error",
      message: "auth.json is missing refresh_token; the adapter cannot rotate access tokens.",
      hint: `Run \`CODEX_HOME=${codexHome} codex login\` to refresh credentials.`,
    });
  }

  // access_token expiry
  const secsLeft = accessTokenSecondsUntilExpiry(auth.tokens.access_token);
  if (secsLeft === null) {
    checks.push({
      code: "access_token_undecodable",
      level: "warn",
      message: "access_token does not look like a JWT — adapter will still attempt refresh on call.",
    });
  } else if (secsLeft < 0) {
    checks.push({
      code: "access_token_expired",
      level: "info",
      message: `access_token is expired (${Math.abs(secsLeft)}s ago); adapter will refresh on first call.`,
    });
  } else {
    const hours = (secsLeft / 3600).toFixed(1);
    checks.push({
      code: "access_token_valid",
      level: "info",
      message: `access_token expires in ~${hours}h.`,
    });
  }

  // chatgpt-account-id resolution
  const accId = resolveChatgptAccountId(auth);
  if (!accId) {
    checks.push({
      code: "missing_account_id",
      level: "warn",
      message: "Could not resolve chatgpt_account_id from id_token claims or tokens.account_id; backend may reject some calls.",
    });
  } else {
    checks.push({ code: "account_id", level: "info", message: `chatgpt-account-id: ${accId}` });
  }

  // model validation (optional config field)
  const model = typeof config.model === "string" ? config.model.trim() : "";
  if (model && !isCodexOAuthKnownModel(model)) {
    const known = models.map((m) => m.id).join(", ");
    checks.push({
      code: "unknown_model",
      level: "warn",
      message: `Configured model "${model}" is not in the verified-working list (${known}).`,
      hint: "ChatGPT-account OAuth backend rejects most other model IDs (gpt-5, gpt-5-codex, gpt-5.2-codex, etc.). Use one of the known IDs unless you have verified the backend accepts the override.",
    });
  }

  return finalize(ctx, checks);
}

function finalize(
  ctx: AdapterEnvironmentTestContext,
  checks: AdapterEnvironmentCheck[],
): AdapterEnvironmentTestResult {
  const status: AdapterEnvironmentTestResult["status"] = checks.some((c) => c.level === "error")
    ? "fail"
    : checks.some((c) => c.level === "warn")
      ? "warn"
      : "pass";
  return {
    adapterType: ctx.adapterType,
    status,
    checks,
    testedAt: new Date().toISOString(),
  };
}
