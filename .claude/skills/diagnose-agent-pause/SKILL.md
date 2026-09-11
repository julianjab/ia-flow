---
name: diagnose-agent-pause
description: Diagnostica por qué una task gestionada por el engine de ia-flow (corriendo en kubectl como flavor `runner`, o su agent-host) queda pausándose / fallando en loop en vez de terminar. Distingue un `pause_turn` legítimo (server-tool cap agotado) de un bug de bloques de server-tool sin parear (`mcp_tool_use`, `tool_search_tool_regex`, ...) que 400ea el siguiente request. Úsalo cuando el usuario reporte "esta tarea se sigue pausando", "el issue vuelve a Refine/Build solo", "veo 🟡 pausado repetido", "agent error" repetido en el board, o pegue un link a un issue de GitHub gestionado por ia-flow con ese patrón.
---

# Diagnosticar una task en pausa/loop del engine ia-flow

Un issue gestionado por ia-flow que "se sigue pausando" tiene dos causas posibles, con
remedios distintos — no las mezcles:

1. **`pause_turn` legítimo**: el server-tool loop de Anthropic (MCP remoto, `tool_search_tool_regex`,
   web search, …) agotó su propio cap de iteraciones por request y Anthropic devolvió el turno.
   El loop del engine (`packages/tools/src/engine.ts` → `handlePauseTurn`) reintenta reenviando
   la historia sin cambios, hasta `maxPauseTurnRetries` (default en
   `packages/shared/src/schemas.ts`, override por agente/provider). Si el agente hace muchas
   rondas de un server-tool en una sola task, agotar el cap es normal, no un bug — se resuelve
   subiendo `maxPauseTurnRetries` o achicando el trabajo por turno (menos MCP round-trips).
2. **Bug de bloque sin parear**: un bloque de server-tool (`type: "*_tool_use"`) queda en el
   turno del assistant sin su `*_tool_result` correspondiente, y reenviar la historia tal cual
   la API la rechaza con 400: `"<tipo> was found without a corresponding <tipo>_result block"`.
   Esto SÍ es un bug del engine — el turno pausado nunca debería reenviarse con un tool_use
   colgado — y cada 400 termina la task con el comentario `🔴`/`⚠️ Agent error`, dejándola
   varada hasta que alguien la mueve manualmente al status anterior para reintentar. Precedente
   ya arreglado para `mcp_tool_use`: subscriptions#1411 / commit `bb6b36ad8`.

**El síntoma que ve el usuario en GitHub es el mismo para las dos** (la task no avanza), así
que hay que leer los comentarios para separarlas.

## Paso 1 — Leer el issue

```bash
gh issue view <número> --repo <owner>/<repo> --comments
```

Buscá dos markers que postea el engine (nunca el MCP de GitHub directo — ver la sección
"Comentarios" del CLAUDE.md raíz):

- `<!-- ia-flow:system-comment -->` con encabezado `# <agentId> · 🟡 pausado` y
  `**Razón**: <stopReason>` — viene de `Agent.ts` (buscá el texto
  `'Avancé pero no terminé'` si necesitás ubicar el código exacto).
- `<!-- ia-flow:agent-error -->` con un bloque de error crudo de la API — viene de un `catch`
  en el orquestador que no llegó a clasificar el fallo como truncado.

Contá cuántas veces se repite cada uno y en qué agente/status. Un mismo agente pausándose
muchas veces seguidas en el mismo status es la señal de "loop".

## Paso 2 — Clasificar cada ocurrencia

| Lo que dice el comentario | Es... | Qué mirar |
| --- | --- | --- |
| `Razón: pause_turn`, sin bloque de error 400 al lado | Caso 1 (legítimo, cap agotado) | `maxPauseTurnRetries` del agente/provider; cuántas llamadas MCP hace el prompt por turno |
| `Razón: max_tokens` / `model_context_window_exceeded` | Otra cosa (budget), no esto | ver `packages/agent-engine/src/failure-taxonomy.ts` → `budget_exhausted` |
| Error 400 `"mcp_tool_use ... found without a corresponding mcp_tool_result block"` | Caso 2, MISMA familia que subscriptions#1411 | Si el fix ya está en `main` (`pairDanglingMcpToolUses` en `packages/tools/src/engine.ts`), esto sería una regresión — revisar si cambió `computeMcpToolUseFlags` |
| Error 400 con **cualquier otro** `"<X>_tool_use ... found without a corresponding <X>_tool_result block"` (ej. `tool_search_tool_regex`, `web_search_tool_use`, `code_execution_tool_use`) | Caso 2, gap conocido | `pairDanglingMcpToolUses` / `computeMcpToolUseFlags` en `packages/tools/src/engine.ts` sólo reconocen bloques `mcp_tool_use` — cualquier otro tipo de server-tool que quede colgado al pausar el turno NO se aparea y se reenvía tal cual, 400eando. Es un bug para reportar/arreglar, no config a tocar. |

`tool_search_tool_regex` aparece cuando el agente tiene MCP con `deferMcpTools` (lazy loading
de tools remotas) — ver `packages/ai-providers/src/anthropic-api/provider.ts` línea ~789.

## Paso 3 — Confirmar con logs de kubectl (si hace falta más detalle)

El runner loguea NDJSON a stdout (`LOG_PLAIN=true`, ver `apps/server/RUNNER-DEPLOY.md`). Ubicá
el pod y filtrá por el runId o el nombre del agente:

```bash
kubectl get pods -n <namespace> -l app=<label-del-runner>   # ajustá el selector al deploy real
kubectl logs <pod> -n <namespace> --since=6h | grep -i "pause_turn\|unresolved mcp_tool_use\|stop_reason"
```

Frases a buscar (vienen literales de `packages/tools/src/engine.ts`):

- `"pause_turn — resuming turn unchanged"` → caso 1, reintento normal.
- `"assistant turn carries an unresolved mcp_tool_use with no client tool_use to defer it — ending run instead of resending or checkpointing it"` → el loop SÍ detectó el colgado y cortó limpio (no 400eó) — no es el bug, es el guard funcionando.
- Un 400 crudo de Anthropic en el log, sin ninguna de las dos frases de arriba antes → el bloque colgado no fue reconocido por `computeMcpToolUseFlags` (probablemente porque no es `mcp_tool_use`) y se reenvió sin parear.

## Paso 4 — Reportar

Con la clasificación:

- **Caso 1**: recomendar subir `maxPauseTurnRetries` en el editor del agente/provider, o
  simplificar el prompt para que haga menos llamadas de server-tool por turno. No es un bug.
- **Caso 2 con `mcp_tool_use`**: revisar si hubo una regresión sobre el fix de
  subscriptions#1411.
- **Caso 2 con otro tipo de bloque**: es un gap real — `pairDanglingMcpToolUses` y
  `computeMcpToolUseFlags` (`packages/tools/src/engine.ts`) generalizan mal: filtran sólo
  `b?.type === 'mcp_tool_use'`. El fix es generalizar la detección/pareo a cualquier bloque
  `type` que termine en `_tool_use` sin su `_tool_result`/`_result` correspondiente en el mismo
  turno, no sólo el de MCP. No apliques este fix sin confirmar el `type` exacto del bloque
  colgado — cada familia de server-tool puede nombrar su bloque de resultado distinto (ver el
  400 exacto, que siempre nombra los dos tipos).

No cierres el diagnóstico recomendando "mover la task al status anterior" sin más — eso es lo
que el propio comentario del engine ya le dice al operador hacer, y si la causa es el Caso 2 el
reintento va a volver a 400ear con el mismo bloque colgado hasta que se arregle el pareo.
