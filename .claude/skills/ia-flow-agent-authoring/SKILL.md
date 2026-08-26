---
name: ia-flow-agent-authoring
description: Autoría y revisión de agentes del engine de ia-flow (AgentDefinition — activación, outcomes, tools, providers, MCP, variables de prompt). Úsalo cuando haya que crear, editar, depurar o auditar un agente del engine (agents/*/agents.*.yaml, la tabla `agents`, o el editor web), cuando un agente no se dispara / se re-dispara en loop, cuando falta una tool o permiso de bash, o al diseñar un pipeline de labels/status. NO es para los subagentes de Claude Code de .claude/agents/.
---

# Autoría de agentes del engine ia-flow

Un **agente del engine** es una fila de `AgentDefinition` (SQLite `agents` o un YAML de
`agents/<deploy>/agents.*.yaml`) que el daemon ejecuta contra issues de un source
(GitHub Project, GitHub Issues, local). No confundir con los subagentes de Claude Code
(`.claude/agents/*.md`), que son otra cosa.

## Modelo mental (leer siempre)

```
① SourceDispatcher.shouldScan   pausa · rate limit · agentes cableados · health del source
② por item (tryDispatch)        anchorLabel · filtro de proyecto · agentWorking · en vuelo · cap
③ TaskDispatcher.dispatch       validate · health · projectId · config · selectAgent · blockers
④ AgentOrchestrator + Workspace status fresco · repo registrado · lock · multi-repo · writePaths
     └─ Agent.run               onProcess → prompt(+git context) → provider → onFinish/onError
```

Un agente que "no corre" puede estar frenado en cualquiera de las cuatro capas — la lista
completa de gates y el checklist de diagnóstico están en `references/dispatch-gates.md`.

Cinco hechos que gobiernan todo diseño:

1. **Un dispatch = UN agente.** No hay cadenas. El pipeline avanza porque el `onFinish`
   del agente cambia el estado del issue (status o labels) y el siguiente scan
   selecciona a otro agente contra ese estado nuevo.
2. **El agente declara sus criterios**, no el status. `statusName` / `when` / `repoName` /
   `projectId` viven en el agente. Vacío = sin restricción.
3. **Un agente sin `statusName` NI `when` es rechazado** (filtro "scope"). Sin uno de los
   dos, nada deja de cumplirse al terminar el run → loop infinito sobre el mismo issue.
4. **El estado que el agente cambia al terminar tiene que ser el mismo que lo activa.**
   Si activa por `when: labels = agent:build`, el `onProcess` debe quitar esa label
   (`$set:Labels=-agent:build`). Si activa por `statusName`, el `onFinish` debe mover el
   status.
5. **Sin `tools[]` no hay tools.** No hay fallback a "todas". Las únicas que no se
   declaran son las internas de ciclo de vida — y de esas, **sólo `fail_task` está en
   todos lados**: `complete_task` es `providerKinds: ['async']`, así que a un provider
   sync (`anthropic-api`) ni se le ofrece.
6. **El prompt nunca afirma el kind del provider.** El cierre se describe por lo que el
   modelo puede observar ("si `complete_task` está entre tus tools…"), no por mecánica del
   engine. El kind de un `remote:` lo declara el gateway en runtime — el YAML no lo sabe.
   Y en sync **el silencio es éxito**: un `end_turn` aplica `onFinish`, así que un prompt
   que no nombra `fail_task` no puede reportar un fallo.
   → `references/providers-and-mcp.md` § "Cierre del run"

## Flujo de trabajo para crear o mejorar un agente

1. **Ubica dónde vive.** Deploy headless → `agents/<deploy>/agents.*.yaml` (+ `projects.yaml`,
   `repos.yaml`, `mcp-catalog.yaml`). Runtime normal → tabla `agents` vía la web / API.
2. **Define la activación** antes que el prompt: proyecto, repo, status o label, y `position`.
   Verifica el punto 3 y 4 de arriba. → `references/activation-and-outcomes.md`
3. **Elige el provider y su config.** `anthropic-api` (sync, con sandbox de worktree y
   tools propias) vs `tmux-claude`/`iterm-claude` (async, CLI de Claude en una terminal).
   → `references/providers-and-mcp.md`
4. **Elige las tools mínimas.** Cada tool de escritura (`fs_write`, `fs_edit`, `bash_run`)
   materializa un worktree y dispara la creación de linked branch. Un agente read-only
   no crea nada. → `references/tools.md`
5. **Escribe el prompt** con las variables reales del catálogo (`{{task.*}}`,
   `{{project.*}}`, `{{variables.*}}`). Lo transversal al proyecto va en
   `systemPrompts`, no repetido en cada prompt. **Solo en positivo**: describí lo
   que el agente tiene y cómo lo usa (sus `tools[]`, el MCP catalogado), nunca lo
   que no tiene o no debe usar — al agente le pasamos lo que puede usar, no tiene
   contexto de lo que no puede. Una prohibición sobre algo fuera de su superficie
   de tools es ruido; una sobre algo que sí está ahí (el provider terminal trae
   Read/Write/Edit/Bash nativos que `tools[]` no gobierna) es una instrucción que
   puede no respetar. Si algo no debe estar disponible, que no esté en
   `tools[]`/`mcpCatalogIds` — no se lo pidas al modelo. → `references/variables.md`
6. **Define los outcomes** (`onProcess` / `onFinish` / `onError`) cerrando el ciclo del
   punto 4. Todo se escribe con `$set:` contra campos del source; los multi-valor
   (`Labels`) usan tokens `+`/`-`. → `references/activation-and-outcomes.md`
7. **Valida contra el checklist** de abajo y, si tocaste YAML de un deploy, corre
   `bun run check`.

## Checklist de revisión (aplícalo a todo agente nuevo o editado)

- [ ] Tiene `statusName` o `when` no vacío (si no, nunca se ejecuta: filtro `unscoped`).
- [ ] El outcome de éxito **saca** al issue del criterio que lo activó (label quitada con
      `$set:Labels=-...` o status movido). Si no, es un loop.
- [ ] Todo lo que el agente escribe va por `$set:` contra un campo que el source realmente
      define (`getFields()`); los multi-valor usan tokens con signo, nunca asignación.
- [ ] El outcome de error deja el issue en un estado terminal o reintentar-able a
      propósito (`blocked`, vuelta al paso anterior), nunca en el mismo criterio activador.
- [ ] `tools[]` es el mínimo necesario. Si tiene `bash_run`, su `allow` está acotado por
      comando y `deny` cubre lo destructivo.
- [ ] Si escribe código sin tools locales (todo por MCP de GitHub) → `requiresBranch: true`,
      si no `{{task.branch}}` viene vacío.
- [ ] `providerConfig` sólo trae campos del schema **strict** de su provider (mezclar
      campos de terminal en `anthropic-api` hace fallar el parseo → config ignorada/rechazada).
      Si el prompt pide un comportamiento tipo "un parámetro de la API" (determinismo, parar en
      un token, forzar una tool) que no está en esa lista, revisa
      `references/anthropic-messages-api.md` antes de asumir que existe un knob para eso.
- [ ] Toda variable `{{...}}` del prompt existe en el catálogo (una desconocida se deja
      literal en el prompt, no falla — es un bug silencioso).
- [ ] Reglas transversales al proyecto están en `systemPrompts` (proyecto o agente), no
      copiadas en cada prompt.
- [ ] `position` refleja la prioridad deseada dentro de su scope (los agentes de proyecto
      siempre ganan a los globales, sin importar `position`).
- [ ] El prompt **nombra `fail_task`** y dice cuándo llamarla (ambigüedad, bloqueo real).
      Sin eso, en sync el run que se rindió cierra como éxito y aplica `onFinish` —
      "terminá con un error" / "la task queda como está" no son instrucciones ejecutables.
- [ ] El cierre exitoso está escrito como condicional sobre la tool ("si `complete_task`
      está entre tus tools… si no, terminá con el resumen en texto"), NO como una
      afirmación del kind ("este agente corre sync"). `complete_task` es async-only y el
      kind de un `remote:` lo decide el gateway en runtime.
- [ ] El prompt no le explica al modelo mecánica interna del engine (`providerKinds`,
      `resolveExecutableTool`, qué infiere del `stopReason`) — no puede verificarla ni la
      necesita para decidir.
- [ ] El prompt está escrito en positivo — describe qué tools usar y cómo, no
      frases tipo "no uses X" / "no tenés Y" / "aunque esté disponible no lo uses".
      Lo que no debe usar se resuelve sacándolo de `tools[]`/`mcpCatalogIds`, no
      pidiéndoselo al modelo.

## Referencias

Cárgalas sólo cuando las necesites:

| Archivo | Cuándo leerlo |
| --- | --- |
| `references/agent-definition.md` | Campo por campo del `AgentDefinition` + YAML canónico |
| `references/activation-and-outcomes.md` | Filtros de selección, DSL `when`, DSL `$set:` (campos simples y multi-valor) |
| `references/tools.md` | Catálogo de tools, aliases, política de `bash_run`, efectos sobre workspace |
| `references/providers-and-mcp.md` | Providers, `providerConfig`, MCP catalog, worktree/branch/git context |
| `references/anthropic-messages-api.md` | Parámetros reales de la Messages API vs lo que `anthropic-api` expone (qué es agente/deploy/no soportado), estado del conector MCP |
| `references/variables.md` | Variables de prompt y system prompts |
| `references/dispatch-gates.md` | Todos los gates (scan → item → dispatch → run) + env knobs + diagnóstico de "no corre" |
| `references/patterns.md` | Recetas completas (pipeline por labels, por status, MCP-only), anti-patrones |

## Fuentes de verdad en el código

- Schemas: `packages/shared/src/schemas.ts` (`AgentDefinitionSchema`, `AgentActivationSchema`,
  `AgentOutcomesSchema`, `McpCatalogEntrySchema`).
- Ops de campo multi-valor: `packages/issue-sources/src/dispatch/field-ops.ts`
  (`applyMultiValueOps`, `MULTI_SELECT_DATA_TYPE`).
- Gates de scan/dispatch: `packages/issue-sources/src/dispatch/` (`source-dispatcher.ts`,
  `project-filter.ts`, `polling-pause.ts`, `divergence-reconciler.ts`).
- Selección: `packages/agent-engine/src/agent-selection.ts`; DSL `when`:
  `packages/issue-sources/src/dispatch/when.ts`; outcomes: `packages/agent-engine/src/outcomes.ts`.
- Tools + policy: `packages/tools/src/` (`policy.ts`, `exec/pattern.ts`, `*/`).
- Providers: `packages/ai-providers/src/`. Ciclo de vida: `packages/agent-engine/src/Agent.ts`.

Ante cualquier duda, el código gana sobre este skill — verifica ahí antes de afirmar.
