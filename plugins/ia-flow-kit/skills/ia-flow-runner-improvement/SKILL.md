---
name: ia-flow-runner-improvement
description: Mejora un runner de ia-flow (el deploy, no el engine) — escribir o cambiar actions propias, elegir providers/MCP, ajustar intake y capabilities, bajar costo/loops/fallas, probar una pipeline en seco y diagnosticar corridas. Úsalo cuando el usuario, parado en un repo de deploy (p. ej. claw-agents), pida "mejorar el runner", "crear una action", "por qué gasta tanto / falla / se traba", "agregar un MCP o provider", o "probar esta pipeline sin tocar producción".
---

# Mejorar un runner de ia-flow

Un deploy = **config** (datos) + **actions propias** (TS) sobre el runner de ia-flow. Casi toda
mejora es config; el código del engine casi nunca. Antes de proponer, ubicá en qué capa vive el
problema.

## Qué capa cambiar

| Síntoma | Capa | Cómo |
| --- | --- | --- |
| Un agente no corre / corre dos veces / loop | pipeline (`on`, `when`, salidas) | skill `ia-flow-agent-authoring` |
| El agente cierra mal, se pasa de rondas, gasta de más | agente: prompt, `actions` mínimas, `providerConfig` (`maxToolRounds`, modelo) | skill `ia-flow-agent-authoring` |
| Falta una tool o acción de negocio | **action propia** del deploy | § Actions |
| Un modelo/CLI/host distinto, fallback entre providers | `providers` de `runner.yaml`, candidatos en orden | `skills/ia-flow-agent-authoring/references/providers-and-mcp.md` |
| Un MCP nuevo o caído | catálogo `mcp` + `mcpServers` del agente | idem |
| El evento no trae el dato que la pipeline necesita | intake: `resolve_task` y payload | `references/engine/runner-readme.md` |
| El asistente/clasificador/branch-namer se porta mal | `capabilities` (`sources.capabilities`) | § Capabilities |
| Algo del engine o del runner mismo falla | **issue en ia-flow**, no un parche en el deploy | § Cuándo es de ia-flow |

## Actions propias

Una action es un `.ts` con `export default defineAction({ id, create })`:

- `<config>/actions/*.ts` → globales del deploy (`sources.actions`); `projects/<id>/actions/*.ts`
  → sólo ese proyecto, y ganan sobre las globales. `actions/_lib/` son helpers, no se registran.
- `create(ctx)` recibe los servicios del runner (`ctx.services`: `github`, `workspace`, `session`,
  `slack`, `slackUsers`, …), el proyecto de la fuente y las `options` del YAML. Contrato completo:
  `references/engine/defineAction.ts`.
- **Qué podés importar:** sólo lo que el bundle sirve como módulo virtual — `@ia-flow/agent-engine`,
  `…-datasource-yaml`, `…-definitions`, `github-api`, `github-auth`, `github-tools`,
  `github-webhook`, `provider-shared`, `runner-v2/actions`, `shared`, `slack-api`, `slack-tools`,
  `telemetry`, `workspace` y `zod`. Cualquier otro paquete rompe al arrancar.
- Antes de escribir una nueva, mirá `references/engine/actions-catalog.md`: si ya existe una
  built-in (`update_issue`, `post_comment`, `create_github_issue`, `add_sub_issue`,
  `mark_blocked_by`, `slack_*`, `request_slack_review`, …), se usa con `options`/`with`.
- Sin `allowWrite` una action que escribe no se le ofrece al agente; un `bash_run` va con `deny`.
- Logs con `createLogger('scope')` de `@ia-flow/telemetry`, no `console.log`. Secretos por nombre
  (`${ENV}`), nunca en el código ni el YAML.

## Capabilities

`assistant`, `assistant.runner-improvements`, `text-classifier`, `file-focus`, `branch-namer` vienen
con el runner. El deploy sólo las pisa declarando un agente propio (otro id) y apuntando
`sources.capabilities.<cap>` a él. El asistente lee con tools `assistant_*` y PROPONE; nunca ejecuta.

## Probar sin tocar producción

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/validate-config.sh <runner.yaml|dir>      # carga y valida todo
# con el runner de ia-flow a mano (checkout o bundle):
… --config <runner.yaml> --event github.<evento> payload.json            # un webhook crudo, mismo camino
… --config <runner.yaml> --replay-pr <owner>/<repo>#<n>                  # un PR real como `opened`
GET /api/explain?ref=<owner>/<repo>%23<n>&event=<tipo>                   # re-planea en seco (runner --serve)
```

Cambiar una pipeline en vuelo: las pausas existentes NO se retoman si cambió de forma. Decí qué
tasks pueden quedar afectadas antes de tocar producción.

## Diagnosticar corridas

Si el deploy trae un skill de diagnóstico (en claw-agents: `diagnose-agent-task`) usalo. Si no: el
runner guarda ejecuciones, trazas y eventos en `IA_FLOW_HOME/runner.sqlite` (`execution_logs`,
`tasks`) y los logs del pod son la fuente real. Buscá la **causa**, no el síntoma: la ejecución, la
entrada de la traza y la línea de config que lo explican.

## Cuándo es de ia-flow (no del deploy)

Excepción del runner, tool que falla siempre igual por un bug, `{{variable}}` que el intake debería
publicar, un provider que no soporta lo que su schema promete, un módulo que falta en el bundle:
redactá un issue para ia-flow (repo `julianjab/ia-flow`) con la ejecución, la entrada de traza y la
config que lo muestran. No lo parchees con un workaround en el prompt.

## Qué le falta saber a un repo que opera un runner

Ver `references/engine/` (generado desde ia-flow): `core.md` (semántica de ejecución),
`definitions.md` (reglas), `runner-readme.md` (runner), `schema.ts` y `RunnerConfig.ts` (schemas),
`defineAction.ts` (contrato de actions), `actions-catalog.md` (qué ya existe). Si hay un checkout de
ia-flow (`$IA_FLOW_REPO`), las fuentes originales mandan sobre estas copias.
