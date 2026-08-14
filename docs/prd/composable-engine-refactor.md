# PRD: Composable engine — ai-providers, issue-sources, agent-engine

## Context

ia-flow already implements the full "execute an issue via an AI agent, then move it in GitHub" pipeline, but everything lives inside `apps/server`, coupled together: providers, GitHub integration, and orchestration are not independently reusable. We want the core restructured into independently composable packages: a single `ai-providers` package defining the AI-provider contract with N implementations, a single `issue-sources` package defining the Issue domain and how issues are obtained (pull/poll or push/webhook) with N implementations, and an `agent-engine` that wires `issue-source → agent execution (ai-provider + tools/mcps/prompts) → issue-source updates`.

This makes adding a new provider (OpenAI, etc.) or a new issue source (GitHub webhook, Linear, Jira) a matter of adding one implementation file, not touching orchestration code. It's also the foundation for a follow-up feature (GitHub App webhook: `@mention` an agent on an issue → it runs and updates the issue) that should land as *just another `issue-sources` implementation* once this refactor is in place — not designed in detail here, but the package boundaries below are drawn with it in mind.

This is a restructuring of existing, working code — not a rewrite. Early phases must be mechanical (behavior-preserving); nothing here should change how the app behaves for a user today.

## Current state (confirmed via exploration — reuse/move, don't rebuild)

- **`IAgentProvider`** contract already exists at `apps/server/src/domain/ports/IAgentProvider.ts:132-138` — clean, only imports types from `@ia-flow/shared`. `ProviderInput`/`ProviderOutput`/`SessionHandle` (same file) are plain data. Already shaped like a package boundary.
  - Implementations: `adapters/anthropic/provider.ts` (coupled to the tool-execution engine `tools/index.ts` — `executeLoop`/`resolveTools`/`ToolContext`), `adapters/tmux/provider.ts` + `adapters/iterm/provider.ts` (both coupled to `adapters/terminal-base/base.ts`, which imports `application/WorkspaceManager.js`). These couplings are the real work in the extraction, not the interface itself.
- **Issue-source contracts** already split cleanly into ports: `ProjectSource` (`project-sources/types.ts:69-168`, pull/read/write), `ITransitionManager` (`domain/ports/ITransitionManager.ts:8-52`, the "updates" side), `IIssueManager` (`domain/ports/IIssueManager.ts:47-76`, the polling/dispatch loop contract, already has `matchesWebhook?(hint)` for push-style routing).
  - Implementations: `adapters/github/source.ts` (+ `transition-manager.ts`, `tools.ts`, `api/*`) — no DB coupling, but relies on server-loaded env vars. `adapters/local/source.ts` — directly imports `domain/ports/ITaskRepository.js` (a real DB leak to fix). `issue-managers/polling-issue-manager.ts` + `webhook-issue-manager.ts` (a webhook-driven `IIssueManager` variant **already exists** — check this first, it may cover much of a future GitHub-webhook source) extend `source-issue-manager.ts`, which pulls in `IStatusRepository`, `agents/pending-tasks.js` (module-level singleton), `polling-pause.js` — server-internal, needs injecting.
- **`Task`** domain type is already in `packages/shared/src/schemas.ts:105`, shared across server+web — reuse as-is, this is the Issue domain type. `IssueItem` (pre-Task shape) is currently server-internal (`issue-managers/types.ts`) — decide whether it moves to `issue-sources` or gets folded into `Task`.
- **`AgentOrchestrator`** (934 lines) and **`TaskDispatcher`** (117 lines) in `apps/server/src/application/` are the existing composition layer — this is what `agent-engine` absorbs. Both already depend on `domain/ports/*` interfaces via constructor injection (not concrete repos) for their DB-facing needs — the right shape already. NOT yet behind a port, needs to move with the engine or become an injected port: `WorkspaceManager`, `agents/pending-tasks.js`, `agents/outcomes.js`, `agents/variable-resolver.js`, `adapters/github/api/linked-branches.js`, `adapters/terminal-base/session-watchdog.js`.
- **Shared-package convention** (`packages/shared/package.json` + `tsconfig.json`) — source-only, `"main"/"types": "./src/index.ts"`, no build step, consumed as `@ia-flow/*: workspace:*`, declared in root `package.json` `workspaces: ["apps/*","packages/*"]`. New packages must follow this exact convention — no new tooling.
- No circular dependency between providers and issue-sources today (neither imports the other) — `AgentOrchestrator` is the union point by design, which is exactly where `agent-engine` belongs.

## Target package layout

```
packages/
  shared/            (unchanged — Task/Issue domain type, cross-cutting schemas)
  ai-providers/       NEW — IAgentProvider contract + ProviderInput/Output/SessionHandle
    src/contract.ts
    src/anthropic-api/   (moved from apps/server/src/adapters/anthropic)
    src/tmux-claude/     (moved from apps/server/src/adapters/tmux + terminal-base)
    src/iterm-claude/    (moved from apps/server/src/adapters/iterm)
  issue-sources/      NEW — ProjectSource / ITransitionManager / IIssueManager contracts
    src/contract.ts
    src/github-polling/  (moved from apps/server/src/adapters/github + issue-managers/polling-issue-manager)
    src/local-fs/        (moved from apps/server/src/adapters/local, ITaskRepository becomes injected)
  agent-engine/       NEW — composition layer
    src/AgentOrchestrator.ts   (moved from apps/server/src/application)
    src/TaskDispatcher.ts      (moved)
    src/WorkspaceManager.ts    (moved)
    src/outcomes.ts, variable-resolver.ts, pending-tasks.ts   (moved)
apps/
  server/            thin host: Hono routes, SQLite repo implementations of the ports,
                     composition/container.ts wiring concrete providers+sources+repos
                     into agent-engine, daemon.ts boot
  web/               unchanged
```

Each new package follows `packages/shared`'s exact convention (source-only TS, `workspace:*`, no build step). `apps/server` keeps owning: HTTP layer, SQLite persistence (concrete `ITaskRepository`/`IStatusRepository`/etc. implementations), env/secrets loading, and the composition root (`container.ts`) that picks which provider/source implementations are active and injects the SQLite-backed ports into `agent-engine`.

Note: a future `issue-sources/src/github-webhook/` implementation (GitHub App auth, webhook receiver) is explicitly out of scope for this PRD — it is the payoff of this refactor, not part of it. Do not build it here.

## Implementation phases

### Phase 1 — Extract `ai-providers` (mechanical, behavior-preserving)
1. Create `packages/ai-providers` with the shared-package convention. Move `IAgentProvider`/`ProviderInput`/`ProviderOutput`/`SessionHandle` from `domain/ports/IAgentProvider.ts` into `src/contract.ts`.
2. Move `adapters/anthropic/provider.ts` into `src/anthropic-api/`. Its dependency on `tools/index.ts` (`executeLoop`/`resolveTools`/`ToolContext`) becomes an **injected port** (`ToolExecutionPort` in the contract) rather than a direct import — `apps/server` supplies the concrete tool engine at composition time. Define `ToolExecutionPort` narrowly (just what `provider.ts` actually calls) so the tool engine itself doesn't need to move.
3. Move `adapters/tmux/provider.ts`, `adapters/iterm/provider.ts`, and `adapters/terminal-base/` into `src/tmux-claude/` / `src/iterm-claude/` (+ shared `terminal-base` helpers within the package). Their `WorkspaceManager.worktreePathFor` dependency becomes an injected `WorktreePathResolver` port.
4. Update `apps/server`'s composition (`container.ts`) to import providers from `@ia-flow/ai-providers` and supply the two new injected ports (tool execution, worktree resolution) with its existing concrete implementations.
5. Run `AgentOrchestrator.test.ts` and any provider tests — must pass unchanged (proves the extraction didn't change behavior).

### Phase 2 — Extract `issue-sources` (mechanical, behavior-preserving)
1. Create `packages/issue-sources`. Move `ProjectSource`, `ITransitionManager`, `IIssueManager`, `IssueItem` into `src/contract.ts` (re-export `Task` from `@ia-flow/shared` rather than duplicating it).
2. Move `adapters/github/` (source, transition-manager, tools, api client) into `src/github-polling/`. It already has no DB coupling — should move cleanly; env-var reads stay as `Bun.env` reads (still works, `apps/server` populates `Bun.env` before the engine boots).
3. Move `adapters/local/source.ts` into `src/local-fs/`; its direct `ITaskRepository` import becomes a constructor-injected port (`apps/server` still owns the concrete SQLite implementation).
4. Move `issue-managers/polling-issue-manager.ts`, `webhook-issue-manager.ts`, `source-issue-manager.ts` in — their `IStatusRepository`/`agents/pending-tasks.js` dependencies become injected ports too (pending-tasks' module-singleton state is the trickiest bit — decide whether it moves into `agent-engine` instead, since it's arguably dispatch/engine state, not source state).
5. **Read `webhook-issue-manager.ts` first** to understand what it's already for before moving it — don't assume it's related to a future GitHub App webhook without checking.
6. Run existing GitHub/local source tests unchanged.

### Phase 3 — Build `agent-engine`
1. Create `packages/agent-engine`. Move `AgentOrchestrator.ts`, `TaskDispatcher.ts`, `WorkspaceManager.ts`, `agents/outcomes.ts`, `agents/variable-resolver.ts`, `agents/pending-tasks.ts`, and the linked-branches concern (either keep inside `issue-sources/github-polling` and expose via the existing `ITransitionManager.getLinkedBranchRef` port, or inject).
2. `agent-engine` depends only on `@ia-flow/shared`, `@ia-flow/ai-providers`, `@ia-flow/issue-sources` — zero `apps/server` imports. All DB-facing needs (execution logs, project config, repos) stay as constructor-injected ports, exactly as `AgentOrchestrator`/`TaskDispatcher` already do today.
3. `apps/server/src/composition/container.ts` becomes the composition root: instantiates SQLite repo implementations, picks active provider(s) from `@ia-flow/ai-providers` and active source(s) from `@ia-flow/issue-sources`, constructs `agent-engine`'s `AgentOrchestrator`/`TaskDispatcher` with all of it injected.
4. Full `bun run check` across the whole workspace must pass before moving on.

## Risks / open items
- `agents/pending-tasks.js`'s module-singleton state is the one piece that doesn't cleanly fit "inject a port" — decide during Phase 3 whether it becomes engine-owned instance state (constructor param, no more module singleton) rather than staying a global.
- Defining `ToolExecutionPort` and `WorktreePathResolver` narrowly enough that `ai-providers` doesn't end up re-importing half of `apps/server` through the back door — review the actual call sites in `provider.ts`/`terminal-base/base.ts` before finalizing the port shape.
- `webhook-issue-manager.ts` may already exist for a reason unrelated to a future GitHub App webhook feature — read it before assuming it's reusable (Phase 2 step 5).
- This is a 3-phase sequential migration touching most of `apps/server/src/application` and `adapters/*`. Land each phase as its own commit (or PR) — pure refactor, verifiable via existing tests with zero behavior change — so a regression is easy to bisect.

## Explicitly out of scope for this PRD
- GitHub App webhook implementation (`issue-sources/github-webhook`), GitHub App auth, Dockerfile/deploy. These build on top of this refactor later, once the package boundaries exist.

## Verification
- After each phase: `bun run check` (biome + typecheck + tests) across the whole workspace; `AgentOrchestrator.test.ts` and any provider/source tests must pass **unchanged** (no test edits) — proves the move didn't alter behavior.
- Package-boundary sanity check: `packages/ai-providers` and `packages/issue-sources` should each typecheck with `apps/server` excluded from the dependency graph (e.g. `bun run --cwd packages/ai-providers typecheck` succeeds without pulling in anything from `apps/server`) — the concrete test that composability was actually achieved, not just files moved.
