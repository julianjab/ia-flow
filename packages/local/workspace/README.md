# @ia-flow/workspace

El checkout donde corre un agente: un clone persistente por repo y un `git worktree` por task,
con locks, reuso seguro y limpieza. Port de `@ia-flow/workspace` (ia-flow), más las piezas que lo
enchufan a [`@ia-flow/agent-engine`](../../agent-engine/core).

## Dos capas

- **`WorkspaceManager`** — el ciclo de vida, sin nada de engine: `ensureLocalClone`,
  `getOrCreateWorktree`, `cleanupTerminalWorktree`, locks por repo y por task. Corre git a través
  de un `ShellRunner` inyectado (`NodeShellRunner` en producción, un stub en los tests).
- **`actions/`** — lo que se agrega o se saca del engine, cada pieza por separado:
  - `WorkspaceSession` — el worktree de CADA corrida, a demanda.
  - `workspaceAction(name, session, policy?)` — `fs_read`/`fs_list`/`fs_grep`/`fs_write`/
    `fs_edit`/`bash_run` como `Action` sobre ese worktree. Se le dan a un agente como cualquier
    otra acción; sacarla del agente es sacarla de su lista.
  - `CleanupWorkspaceAction` — paso opcional de pipeline (`cleanup_workspace`) que suelta el
    worktree si no tiene trabajo en riesgo.
  - `RunAgentAction` (`run_agent`) — delega en un sub-agente de Claude Code del repo
    (`<worktree>/.claude/agents/*.md`), como la tool `Task`. La traducción vive acá, no en el
    engine: el cuerpo del `.md` es el system prompt, `model` (`sonnet`/`opus`/`haiku`) pasa a un
    id, y `tools` a las de disco sobre el mismo worktree (`Read`→`fs_read`, `Grep`→`fs_grep`,
    `Glob`/`LS`→`fs_list`, `Edit`/`MultiEdit`→`fs_edit`, `Write`→`fs_write`, `Bash`→`bash_run`; el
    resto se descarta). Sin `write` los sub-agentes sólo leen. El hijo corre fuera de la
    pipeline (`runForResult` del engine): no delega, no ocupa topes, entrega `summary`.

## Uso

```ts
import { Agent } from '@ia-flow/agent-engine';
import { NodeShellRunner, WorkspaceManager, WorkspaceSession, workspaceAction } from '@ia-flow/workspace';

const manager = new WorkspaceManager(new NodeShellRunner(), {
  reposBase: '/var/lib/agents/repos',     // clones, persistentes
  worktreeBase: '/var/lib/agents/wt',     // worktrees, uno por task
  githubToken: () => auth.getToken(),     // se pide en cada comando de red: tokens que rotan
  syncBranchWithRemote: true,             // ver abajo
});

// Qué checkoutear para una corrida — lo decide la app, desde SU evento.
const session = new WorkspaceSession(manager, (ctx) => ({
  task: { id: ctx.event.payload.taskId, issueNumber: ctx.event.payload.number },
  repo: { name: 'subscriptions', githubOwner: 'la-haus', githubRepo: 'subscriptions' },
  branch: ctx.event.payload.branch,
}));

const reviewer = new Agent({
  id: 'reviewer',
  provider: 'anthropic-api',
  prompt: '...',
  actions: [
    workspaceAction('fs_read', session),
    workspaceAction('bash_run', session, { allow: ['git diff *', 'uv *'], deny: [] }).allowWrite(),
  ],
});
```

La primera tool de disco que el agente llama en una corrida prepara el worktree; las siguientes de
esa corrida lo reusan. Un agente sin tools de disco no clona nada.

## Qué cambia respecto de ia-flow

- **`NodeShellRunner`** en vez de `BunShellRunner`, sin la resolución de versión de Node con `fnm`
  para los hooks de `git commit`.
- **Logger por instancia** (`opts.log`) en vez del factory global `setLoggerFactory`.
- **`syncBranchWithRemote`** (default `false`, el comportamiento de ia-flow): al reusar un
  worktree, adelanta la branch a `origin/<branch>` si el remoto está por delante y es
  fast-forward. En ia-flow el único que escribe la branch es el engine; si la branch la pushea
  otro (un humano, otra máquina), sin esto un reviewer revisaría el commit viejo.
- **`cloneUrl`** — de dónde clonar (default GitHub).
- **Worktree por carril** (`getOrCreateLaneWorktree`): los miembros de un grupo `parallel` del
  engine (ej. reviewer y e2e a la vez) comparten el evento, y `WorkspaceSession` los separa por
  `ctx.lane` en `<worktree de la task>--<carril>`, en `--detach` sobre la branch de la task (git no
  deja la misma branch en dos worktrees). Son de lectura: para verificar, no para pushear. Se
  refrescan con `checkout --force` (lo ignorado, como `node_modules`, sobrevive) y se borran con el
  worktree de la task.
- No se portó `provisioners.ts`: depende de los tipos del engine de ia-flow (`WorkspacePlan`);
  su rol acá lo cumplen `WorkspaceSession` + `workspaceAction`.

## Límites

- La credencial viaja como `-c http.https://github.com/.extraHeader=…` en el argv de cada `git`
  de red (visible en `ps` mientras corre) — nunca en `.git/config`, así que un agente con
  `fs_read` o `git config` no la ve. Mismo trade-off que ia-flow. Va scopeada a GitHub y con
  `core.hooksPath=/dev/null`: git pasa los `-c` a sus hooks por `GIT_CONFIG_PARAMETERS`, y un hook
  que un agente dejó en el clone compartido leería el token.
- `WorkspaceSession` no toma el lock por task del manager (el engine no tiene un "fin de corrida"
  donde soltarlo): que dos corridas de la MISMA task no se pisen es trabajo del que despacha.
