---
name: ia-flow-agent-authoring
description: Autoría y revisión de agentes y pipelines del engine de ia-flow (los YAML de una config del runner — `runner.yaml`, `projects/<id>/{agents,pipelines,repos}`): disparo (on/when/whenText), salidas y rutas, actions, providers, MCP, variables de prompt. Úsalo cuando haya que crear, editar, depurar o auditar un agente o una pipeline, cuando un agente no se dispara / se re-dispara en loop, cuando le falta una action o un permiso de bash, o al diseñar el flujo de columnas/labels de un board. NO es para los subagentes de Claude Code de .claude/agents/.
---

<!-- GENERADO por scripts/sync-plugin-docs.ts desde .claude/skills/ia-flow-agent-authoring/SKILL.md. No editar: cambiá la fuente y corré `bun run plugin:sync`. -->

> Instalado como plugin: las fuentes de verdad que cita este skill vienen copiadas en
> `${CLAUDE_PLUGIN_ROOT}/references/engine/` (core.md, definitions.md, runner-readme.md,
> schema.ts, RunnerConfig.ts, defineAction.ts, actions-catalog.md). Con un checkout de ia-flow
> (`$IA_FLOW_REPO`), las rutas originales mandan sobre las copias.

# Autoría de agentes del engine ia-flow

Un **agente del engine** es un YAML (`AgentDoc`) que `apps/runner-v2` corre contra las tasks de
un board de GitHub; una **pipeline** (`PipelineDoc`) dice con qué evento corre y qué pasos da. No
confundir con los subagentes de Claude Code (`.claude/agents/*.md`).

Fuentes de verdad — leelas, no las copies:

| Qué | Dónde |
| --- | --- |
| Forma de agente, pipeline y fuente (zod) | `packages/agent-engine/definitions/src/schema.ts` |
| Reglas de la definición (brief, `ref`, `{{vars}}`, `allowWrites`, `whenText`, `http`) | `packages/agent-engine/definitions/CLAUDE.md` |
| Semántica de ejecución (salidas, cascada de rutas, `injects`, pausas, `ifRunning`, `ifQueued`, topes) | `packages/agent-engine/core/CLAUDE.md` |
| Forma de `runner.yaml` / `project.yaml` | `apps/runner-v2/src/config/RunnerConfig.ts`, `apps/runner-v2/README.md` |
| Config real de referencia (producción de La Haus) | `la-haus/claw-agents` → `agents/ai-development-flow/config/` |

Si el código contradice este skill, gana el código.

## Modelo mental

```
webhook github.<evento> ─► intake (resolve_task, en runner.yaml) ─► evento de task con payload
      (issue.status_changed, issue_comment, pull_request_review, check_suite, …)
  ─► cada pipeline: on → scope(projectId) → when → whenText ─► exclusive/position eligen
  ─► do[]: pasos en orden (firstMatch: el primero cuyo when pasa)
  ─► paso agent: onStart → prompt(brief + prompt) → provider → UNA salida (submit_<salida>)
  ─► report (comentario) → destinos de la salida (update_issue, pause, …)
  ─► el cambio que hizo la salida vuelve como webhook → otra pipeline
```

Hechos que gobiernan todo diseño:

1. **El disparo vive en la pipeline, no en el agente.** `on` + `when` (+ `whenText`) de la
   pipeline y el `when` de cada paso. El agente es reusable entre pipelines; lo específico del
   momento va en el `brief` del paso.
2. **Una pipeline por momento del flujo, no por variante.** `firstMatch: true` hace de `do` una
   lista de alternativas (un agente por tipo o repo) y el orden es la prioridad. Un mismo agente
   no puede ser dos pasos de una pipeline: dos momentos distintos son dos pipelines
   (`20-build-arrival` / `21-build-reentry`).
3. **Un agente termina eligiendo UNA salida** con `submit_<salida>` (sin `routes`, hay una
   implícita: `done`), o `fail_turn` (→ `onError`), o `yield_turn` si lo interrumpieron
   (→ `onInterrupt`). El `when` de cada salida es texto para el modelo: cuándo elegirla.
4. **Las salidas cierran el ciclo.** El destino (típicamente `update_issue` con otro `status`)
   saca a la task del `when` que la disparó. Si no, la próxima vuelta del webhook la vuelve a
   disparar: loop. Encadenar agentes va en `routes.<agentId>` de la pipeline, nunca con ciclos;
   un "review → build" pasa por un evento (el cambio de status).
5. **Sin `actions` no hay actions.** El agente sólo ve lo que lista (más las tools de cierre y,
   si declara `waits`, `wait_for_event`). Las que escriben necesitan `allowWrite: true` en su
   entrada o `allowWrites: true` en el agente. Un provider CLI trae además sus tools nativas, que
   `actions` no gobierna.
6. **Una task corre un agente a la vez.** Un evento para una task ocupada: si el agente lo acepta
   (`injects`), se le inyecta; si no, la pipeline decide con `ifRunning` (`wait`/`skip`/
   `interrupt`) e `ifQueued` (`replace`/`keep`).

## Flujo de trabajo

1. **Ubicá dónde vive.** Proyecto → `projects/<id>/agents/NN-<nombre>.yaml` y
   `projects/<id>/pipelines/NN-<momento>.yaml` (el `NN-` ordena la lectura). Las capacidades
   (`assistant`, `text-classifier`, `file-focus`, `branch-namer`) vienen con el runner
   (`apps/runner-v2/src/capabilities/`); un deploy sólo las pisa con un agente propio, de otro id,
   en `sources.agents` + `sources.capabilities`. Nada se
   descubre por carpeta: `runner.yaml`/`project.yaml` declaran cada directorio.
2. **Diseñá el disparo** en la pipeline: evento, `when` sobre `item.*`/`task_type`/campos del
   evento, `scope`, `exclusive`/`position`, `ifRunning`. → `references/pipelines.md`
3. **Elegí provider(s) y su config.** → `references/providers-and-mcp.md`
4. **Elegí las actions mínimas** y sus `options` (`bash_run` con `allow`/`deny`).
   → `references/agents.md` § Actions
5. **Escribí el prompt** con variables reales del payload. El método va en `systemPrompts`
   (cacheable); en `prompt`, sólo lo que tiene `{{`; lo del momento, en el `brief` del paso.
   → `references/variables.md`
6. **Declará las salidas** (`routes`), su `report`, y confirmá `onError`/`onInterrupt` (los del
   proyecto aplican si el agente no los pisa). → `references/agents.md` § Salidas
7. **Validá cargando** (abajo) y pasá el checklist.

## Validar

```bash
bun run runner                                            # tu .config local: carga y valida
bun run --cwd apps/runner-v2 start --config <runner.yaml|dir>         # otra config (un deploy)
```

Un error de schema sale con archivo y campo. Con el runner en `--serve`,
`GET /api/explain?ref=<owner>/<repo>%23<n>&event=<tipo>` re-planea el último evento de esa task
(o uno sintético de ese tipo) en seco: qué pipeline correría y por qué las demás no.

## Prompts

- **En positivo.** Describí lo que el agente tiene y cómo usarlo. Lo que no debe usar se saca de
  `actions`/`mcpServers`; pedírselo al modelo es ruido o una instrucción que puede ignorar.
- **Nombrá cada salida y `fail_turn`** con cuándo usarla. Una salida declarada que el prompt no
  menciona casi nunca se elige.
- **No le expliques mecánica del engine** (cascada de rutas, `ifRunning`, providers): no la
  puede verificar ni la necesita.
- **Si recibe inyecciones** (`injects`), un system prompt le dice qué forma tienen y que tienen
  prioridad (ver `20-implementer.yaml`).
- Lo transversal del proyecto va en `systemPrompts` de `project.yaml`, no copiado en cada agente.

## Checklist (todo agente o pipeline nuevo o editado)

- [ ] La pipeline tiene `on` real (un tipo que publica el intake o un evento derivado) y un
      `when` que la salida de éxito deja de cumplir. El eco del cambio no la re-dispara.
- [ ] El paso del agente filtra `item.blocked` salvo que deba correr bloqueado.
- [ ] `exclusive`/`position`/`firstMatch` resuelven quién gana entre pipelines y pasos que
      matchean el mismo evento; el orden de `do` es la prioridad con `firstMatch`.
- [ ] `ifRunning` pensado: `interrupt` si el evento invalida lo que hace el agente (la card se
      movió), `wait` si no. `ifQueued: keep` donde cada evento cuenta (comentarios).
- [ ] Si acepta `injects`, su `when` también excluye lo que publica el propio engine
      (`<!-- ia-flow:`): los injects son todo el filtro.
- [ ] Cada salida de `routes` tiene `when` claro y destino (en el agente o en la pipeline), y
      está nombrada en el prompt. Una `pause` va última en su lista y tiene `timeout`.
- [ ] `actions` es el mínimo; las que escriben tienen `allowWrite`/`allowWrites`; `bash_run`
      con `deny` de lo destructivo.
- [ ] `providerConfig`/`providers[].config` sólo trae claves del schema de ese provider.
- [ ] Toda `{{variable}}` existe en el payload del evento que lo dispara (una desconocida queda
      literal, sin error). `{{vars.x}}` existe en la fuente (si no, no carga).
- [ ] Secretos sólo nombrados (`${ENV}`), nunca en el YAML.
- [ ] La config carga sin errores (`bun run runner` o `start --config <runner.yaml|dir>`).

## Referencias

| Archivo | Cuándo leerlo |
| --- | --- |
| `references/pipelines.md` | Disparo: eventos, `when`/`whenText`, `scope`, prioridad, `firstMatch`, `ifRunning`/`ifQueued`/`ifPaused`, overrides de rutas |
| `references/agents.md` | Campos del agente: actions, `injects`, `waits`, `onStart`, salidas (`routes`, `pause`), `report`/`onError`/`onInterrupt` |
| `references/variables.md` | Qué hay en el payload (`item.*`, `task.*`, `event.payload.*`, `input.*`, `steps.*`, `vars.*`) |
| `references/providers-and-mcp.md` | Providers de `runner.yaml`, candidatos en orden, `remote:*`, `providerConfig`, catálogo `mcp`, `mcpHost` |
