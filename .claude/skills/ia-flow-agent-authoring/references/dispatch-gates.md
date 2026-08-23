# Todos los gates: de un issue del source a un agente corriendo

Un issue atraviesa **cuatro capas** de filtros. Si un agente "no corre", el culpable puede
estar en cualquiera — no sólo en `selectAgent`. Esta es la lista completa, en orden.

```
① scan (SourceDispatcher)   → ② por item → ③ dispatch (TaskDispatcher) → ④ run (Orchestrator + Workspace)
```

---

## ① Antes de mirar ningún issue — `SourceDispatcher.shouldScan()`

Corta el ciclo entero del proyecto. `packages/issue-sources/src/dispatch/source-dispatcher.ts`.

| Gate | Corta cuando | Dónde se configura |
| --- | --- | --- |
| **Proyecto pausado** | `isProjectPaused(projectId)` | En memoria (`pauseProject`), escape hatch de operador. **No persiste** — un restart del daemon reanuda todo. |
| **Rate limit de GitHub** | El limiter global está agotado | Automático; loguea una vez y reanuda solo al reset. |
| **Sin agentes cableados** | `visibleTo(projectId)` no tiene ningún agente con `enabled !== false`, **y** no hay ningún pending del proyecto | Habilitar al menos un agente. Este gate evita hasta el `getItems()`. |
| **Source unhealthy** | `getHealth().ok === false` | Faltan campos de `source.config`. Ej. `github-issues` exige `owner`, `repo`, `anchorLabel`; los reporta en `missing[]`. |

También decide **cómo** llega el trabajo (`daemonMode`): `webhook` (default) o `polling`.
Resolución: `project.settings.daemonMode` → `IA_FLOW_DAEMON_MODE` → `webhook`. Acepta
alias (`pull`, `push`, `poll`, …).

## ② Por item — filtro de proyecto y anti-duplicados

`SourceDispatcher.tryDispatch()`. Estos corren **antes** de `TaskDispatcher`, así que el
item ni siquiera llega a evaluarse contra agentes.

| Gate | Descarta cuando |
| --- | --- |
| **Ancla del source** | (`github-issues`) el issue no tiene el `anchorLabel` — se filtra en el propio `getItems`, nunca entra al batch. |
| **Filtro de proyecto** | `project.settings.{statusName, repoName, when}` no matchea. Es un `selectAgent` en miniatura, un nivel por encima: mismo DSL `when`, misma semántica de status/repo, pero para TODO el proyecto. |
| **`agentWorking`** | El source dice que ya hay un agente trabajando el issue (`meta.working === true`). |
| **Ya en vuelo** | El id está en `dispatching` o tiene un pending task registrado. |
| **Cap de runs** | Hay `IA_FLOW_MAX_CONCURRENT_DISPATCHES` agentes **corriendo** para el proyecto. Se cuenta del registro de pending tasks (`Agent.run` registra ahí justo antes de llamar al provider), NO de los items en evaluación: un item que los gates rechazan nunca arranca un agente y por eso no consume slot. |
| **Guarda de evaluación** | `dispatching.size >= IA_FLOW_MAX_CONCURRENT_EVALUATIONS` (default 20). Freno de ráfaga sobre las llamadas al source (`getHealth`/`getBlockers`/`loadComments`), no política de concurrencia — vive bien por encima del cap de runs. |

> Si un agente "no corre y no hay nada en los logs de `agent-selection`", sospechá de esta
> capa: acá el descarte es silencioso o `debug`, porque es tráfico normal.
>
> Ambos límites difieren en `deferred` y se reintentan al liberarse un slot (backoff
> exponencial, techo `IA_FLOW_CONCURRENCY_RETRY_MAX_MS`). El log `Capacity reached` trae
> `running`/`runCap` y `evaluating`/`evalCap` — mirá cuál de los dos se saturó antes de
> tocar nada: tienen arreglos opuestos.

## ③ Dispatch — `TaskDispatcher.dispatch()`

`packages/agent-engine/src/TaskDispatcher.ts`. En este orden:

| # | Gate | Descarta cuando |
| --- | --- | --- |
| 1 | `manager.validate(item)` | El source considera el item inválido (implementación opcional por source). |
| 2 | `projectId` presente | El manager no estampó el proyecto en el item. |
| 3 | `getHealth()` (red de seguridad) | El source se degradó después del scan (token vencido, URL editada). |
| 4 | `configRepo.getConfig(projectId)` | El proyecto no tiene config. |
| 5 | **`selectAgent`** | Ningún agente pasa los 5 filtros (`unscoped`/`project`/`repo`/`status`/`when`/`disabled`). Ver `activation-and-outcomes.md`. |
| 6 | **Blockers** | El agente elegido tiene `allowBlocked: false` (default) y `getBlockers` devuelve dependencias abiertas. |

Recién después de pasar todo se cargan los comentarios (`loadComments`, lazy — por eso
`{{task.comments}}` sólo existe post-gate).

## ④ Run — `AgentOrchestrator.runAgent()` + `WorkspaceManager`

| Gate | Qué pasa |
| --- | --- |
| **Re-lectura de status fresco** | Antes de seleccionar, `getCurrentStatus()` re-lee el status en la fuente. Si cambió mientras el item hacía cola, se **re-selecciona** contra el valor nuevo — puede terminar corriendo otro agente, o ninguno. |
| **Repo no registrado** | Si `task.repos[0]` no existe en la tabla `repos` del proyecto → **error** en logs y el dispatch se aborta. El fix es registrar el repo en ia-flow o corregir el campo "Repos" del issue. |
| **Repo sin `path` local** | Si tiene `githubOwner`/`githubRepo`, `WorkspaceManager` lo clona y persiste el path. En deploys con repos YAML (read-only) ese `upsert` **falla** — por eso `repos.yaml` debe traer `path` siempre. |
| **Lock por task** | `acquireTask(taskId)` tira `task <id> ya está corriendo` si otro dispatch lo tiene. Sólo aplica a runs con workspace (`anthropic-api` + path). |
| **Multi-repo guard** | `WorkspaceManager.resolveScopes` tira si `task.repos.length > 1`: el sandbox soporta un solo repo (síntoma de una task mal refinada / épica sin desglosar). |
| **`writePaths` vacío** | `bash_run` y las write tools rechazan con "escritura no permitida en fase actual" si el run no tiene zona escribible. |
| **Política de `bash_run`** | Por comando: `deny` gana, sin match en `allow` se rechaza, y `git -C` / `--git-dir` / `--work-tree` siempre se rechazan. |
| **`providerConfig` strict** | Un campo ajeno al schema del provider hace fallar el parseo → la config se descarta (terminal) o se rechaza. |
| **Divergence reconciler** | Timer independiente (`IA_FLOW_RECONCILE_INTERVAL_MS`, default 30s) que revisa los runs `pending`: si el status del issue derivó respecto de donde se despachó, **aborta el run en vuelo** vía `AbortSignal`. |
| **Session watchdog** | Providers async: si la sesión tmux/iTerm muere, el run no queda colgado como in-flight. |

## Env knobs de la capa de dispatch

| Var | Default | Efecto |
| --- | --- | --- |
| `IA_FLOW_DAEMON_MODE` | `webhook` | `webhook` \| `polling` (con aliases). |
| `IA_FLOW_POLL_INTERVAL_MS` | `30000` | Intervalo en modo polling. |
| `IA_FLOW_WEBHOOK_DEBOUNCE_MS` | `1500` | Coalesce de ráfagas de eventos. |
| `IA_FLOW_WEBHOOK_FALLBACK_MS` | `0` (off) | Scan periódico de red de seguridad en modo webhook. |
| `IA_FLOW_MAX_CONCURRENT_DISPATCHES` | `5` | Agentes corriendo a la vez por proyecto (se cuenta de los pending tasks). |
| `IA_FLOW_MAX_CONCURRENT_EVALUATIONS` | `20` | Items evaluándose a la vez por proyecto — freno de ráfaga de llamadas al source. |
| `IA_FLOW_CONCURRENCY_RETRY_MAX_MS` | `60000` | Techo del backoff al reintentar diferidos. |
| `IA_FLOW_RECONCILE_INTERVAL_MS` | `30000` | Frecuencia del reconciler de divergencia. |

## Checklist de diagnóstico: "mi agente no corre"

Recorré las capas de arriba hacia abajo — la mayoría de los falsos "bug del agente" están
en ① y ②:

1. ¿El proyecto está pausado o rate-limited? ¿Hay algún agente `enabled` en el proyecto?
2. ¿El source está healthy? (`missing[]` en el log de health.)
3. ¿El issue tiene el `anchorLabel` del source?
4. ¿`project.settings.{statusName,repoName,when}` lo está filtrando antes de los agentes?
5. ¿El issue quedó marcado `working` de un run anterior que murió?
6. ¿Estás contra el cap de concurrencia? (log `Concurrency cap reached`.)
7. Recién ahí: `agent-selection` → `rejected: <razón>: <ids>` en los logs.
8. ¿Tiene blockers abiertos y el agente es `allowBlocked: false`?
9. ¿El repo del issue está registrado en el proyecto y con `path`?
