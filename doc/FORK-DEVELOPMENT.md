# FORK-DEVELOPMENT.md

Guidance for working on this fork of `paperclipai/paperclip` — branching policy, upstream-merge etiquette, and the TDD playbook used for fork-only adapters.

> **Why a separate file?** `AGENTS.md` is the upstream-shared contributor doc. Fork-specific conventions live here so that re-syncing with upstream never produces a merge conflict on `AGENTS.md`. `AGENTS.md §11` (Fork-Specific) carries a one-line pointer to this file.

---

## 1. Repository Layout for Fork Work

- `origin` → `https://github.com/sunghere/paperclip.git` (this fork)
- `upstream` → `https://github.com/paperclipai/paperclip.git`
- `master` (this fork) tracks `upstream/master` plus a small set of fork-only commits (currently: decision-note approvals, fork-only adapters).

Long-lived fork-only branches (e.g. `feat/externalize-claude-code-adapter`) are documented in `AGENTS.md §11`. New fork work goes on short-lived feature branches off `master`.

## 2. Golden Rule: Minimize Upstream-File Edits

Every line we change in an upstream-tracked file is a future merge conflict. Goal: **fork-only features touch ≤ 5 upstream lines, ideally just import + array-entry pairs.**

### Concrete pattern: fork-only adapter

When adding a fork-only adapter (example: `codex_oauth_local`), the layout is:

| File | Status | Edit size |
|---|---|---|
| `packages/adapters/<name>/**` | **new package** | unbounded — fork owns it |
| `server/src/adapters/<name>-hookup.ts` | **new fork-local file** | the registration glue lives here, not inline |
| `server/src/adapters/registry.ts` | upstream | +2 lines (import + array entry) |
| `server/src/adapters/builtin-adapter-types.ts` | upstream | +1 line (Set entry) |
| `server/src/services/quota-windows.ts` | upstream | +2 lines (switch case) |
| `server/package.json` | upstream | +1 line (workspace dep) |
| `ui/src/adapters/<name>/**` | **new fork-local files** | UI module owns its own dir |
| `ui/src/adapters/registry.ts` | upstream | +2 lines (import + array entry) |
| `ui/package.json` | upstream | +1 line (workspace dep) |

**Total upstream-file delta: 9 lines across 6 files.** Conflicts on re-merge are essentially trivial.

### Anti-patterns

- ❌ Editing logic inside `registry.ts` (put logic in `<name>-hookup.ts`)
- ❌ Adding fork-only types to upstream-shared type files (extend in your package)
- ❌ Modifying upstream tests for fork-only behavior (add new test files instead)
- ❌ Renaming/reorganizing upstream files "while we're here"

## 3. Branching Policy

- Branch off the latest `master` (this fork's master, not upstream's).
- Naming: `feat/<slug>`, `fix/<slug>`, `refactor/<slug>`, `docs/<slug>`.
- **One feature per branch.** PRs that mix decision-note + adapter work create reapply pain.
- **Commit splits:** keep upstream-file edits in their own commit (e.g. "wire up codex-oauth-local hookup"). The fork-only package goes in a separate commit. This makes `git revert` and cherry-pick clean.

## 4. Upstream Sync Workflow

When pulling upstream:

```sh
git fetch upstream
git checkout master
git rebase upstream/master         # not merge — keep history linear
# resolve conflicts; prefer the upstream version when behavior overlaps
git push --force-with-lease origin master
```

If a fork-only commit has been duplicated upstream (e.g. they accepted our PR), `rebase` will silently drop it — that's the desired outcome.

## 5. TDD Playbook for Fork-Only Adapters

The fork has historically shipped adapters without unit tests. **This is now the contract for new fork-only packages:**

> Every fork-only package under `packages/adapters/<name>/` ships with a Vitest suite covering its server-side core. Wireup glue (`<name>-hookup.ts`) is exempt; everything else is not.

### 5.1 Required test surface

For an adapter that calls a remote API (the common case for OAuth/HTTP adapters):

| Module | Why test it | Mocking strategy |
|---|---|---|
| `oauth-store.ts` | Auth-file IO + JWT decode are easy to break silently | Real `fs` against a `tmpdir`. JWT decoded with hand-built fixtures (header.payload.sig). |
| `oauth-refresh.ts` | Refresh tokens are single-use — botched rotation locks the user out | `vi.fn()` patched onto `globalThis.fetch`. Verify the refresh body (form-encoded `grant_type`, `client_id`, `refresh_token`). |
| `codex-http.ts` (or equivalent SSE accumulator) | The ChatGPT backend returns `response.completed.output: []` and items must be collected from `response.output_item.done` events. **A naïve "read `output` from `completed`" implementation passes a happy-path manual smoke test and silently drops every output in production.** | Feed a hand-built SSE stream string into the parser. Assert accumulated items. |
| `parse.ts` (error classification) | Misclassifying a 401 vs a 429 changes retry vs auth-refresh behavior | Plain functions, plain inputs. |
| `execute.ts` (adapter contract impl) | Glue between SSE accumulator + Paperclip's `AdapterExecutionResult` shape | Mock the HTTP layer, exercise the adapter contract end-to-end. |

UI parser stubs and `index.ts` constants don't need direct tests — they are exercised via the registry.

### 5.2 RED-first vs. Backfill

The Iron Law of TDD ([`test-driven-development` skill](https://github.com/anthropics/claude-skills)) is "no production code without a failing test first". When adding a **new** adapter, follow it strictly.

When **backfilling tests onto existing code** (this fork's recurring case), the substitute discipline is **mutation testing by hand**:

1. Write the test against the existing implementation.
2. Make a deliberate breaking change to the production code (e.g. delete the SSE accumulator, return `null` from a refresh, drop the `chatgpt-account-id` header).
3. Run the test — it MUST fail. If it doesn't, the test isn't actually testing what it claims.
4. Revert the breaking change.
5. Run the test — it MUST pass.

This recreates the RED-GREEN evidence. **A test you never watched fail is not a test, it is a hopeful assertion.**

Document any test that was backfilled this way with a short comment naming the mutation that was used to verify it:

```ts
// Verified RED by hand: deleted accumulator, then the test failed with
// `expected items.length to be 1, got 0`. Restored, test goes green.
it("collects output items from response.output_item.done events", () => { ... });
```

### 5.3 Fixtures over recordings

Don't VCR/replay real ChatGPT responses into the repo (PII, auth headers, drift). Build minimal hand-written SSE strings as fixtures. Example:

```ts
const SSE = [
  `event: response.created`,
  `data: {"type":"response.created"}`,
  ``,
  `event: response.output_item.done`,
  `data: {"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":"hi"}]}}`,
  ``,
  `event: response.completed`,
  `data: {"type":"response.completed","response":{"output":[]}}`,
  ``,
].join("\n");
```

This both serves as a test fixture and **doubles as living documentation of the wire format** — invaluable when the upstream API drifts.

### 5.4 Vitest layout

- Tests colocate next to their target: `src/server/oauth-store.test.ts`, not a separate `tests/` tree.
- Each adapter package ships its own `vitest.config.ts` (or borrows from root if behavior matches).
- `pnpm --filter @paperclipai/adapter-<name> test` runs the package suite. The repo-root `pnpm test` aggregates.

### 5.5 What NOT to test

- The Paperclip `AdapterContract` shape itself (upstream covers this).
- Network-attached behavior with real credentials (gate behind an env var; default-skip in CI).
- UI parser stubs — the contract is "no-op", not worth a fixture.

## 6. PR Etiquette (Fork-Specific)

- `gh pr create --repo sunghere/paperclip ...` — without `--repo` the gh CLI defaults to upstream and rejects with `"Head sha can't be blank"`.
- Use the existing PR template (`.github/PULL_REQUEST_TEMPLATE.md`). Fork-specific PRs still fill in **Thinking Path / What Changed / Verification / Risks / Model Used / Checklist**.
- Under "Verification", if the change adds an adapter package, the PR body must list the explicit test command, e.g. `pnpm --filter @paperclipai/adapter-codex-oauth-local test`.

## 7. Pointers

- Upstream contributor doc: `AGENTS.md`
- Fork QoL minkes & long-lived branches: `AGENTS.md §11`
- Plugin loader (alternate path for adapters): `packages/plugins/`
- TDD principles: skill `test-driven-development` (in agent toolchain)

---

_Last updated: alongside the introduction of the `codex_oauth_local` adapter._
