# OTel local — trazas y logs del runner en Grafana

Backend OpenTelemetry local para el runner: un solo contenedor (`grafana/otel-lgtm`) con OTel Collector,
Tempo (trazas), Loki (logs), Prometheus y Grafana, más tres dashboards en la carpeta `ia-flow`:
**ia-flow · issue** (todo lo de un issue), **ia-flow · eventos** (qué pasó con cada evento) e
**ia-flow · agentes y tools** (métricas).

```bash
bun run otel                                                    # desde apps/runner-v2 (docker compose)
open http://localhost:3000                                      # Grafana, sin login
open http://localhost:3000/d/ia-agents-tools                   # métricas por agente y tool
```

## Dashboard «issue»

http://localhost:3000/d/ia-issue — arriba, la lista de **issues** con actividad en el rango:
`Estado` (▶ corriendo · ⏸ pausada · ✗ cortada · inactivo), última actividad, eventos, pasos de agente y errores.
Click en un issue → su detalle abajo (o el selector `Issue`, o por URL: `?var-issue=<owner>/<repo>%23<n>`).
Arriba: `Issue` y `Agente` (listas desde Tempo, filtradas por el issue), `Ejecución` (la pone el
click en una ejecución), `Buscar en los logs` y `Ruido` (esconde las líneas repetidas o los
resultados de las tools en los logs). Agente y ejecución filtran todo el detalle.

- **Resumen**: pasos de agente, llamadas a tools, tools que fallaron, comandos bash, errores.
- **Ejecuciones del issue**: todas las del rango, con pipeline, estado, resultado (`done`,
  `superseded`…), cuándo abrió, duración, pasos de agente, tools y errores. Sale de los logs
  `abre / se pausa / se reanuda / cierra`; la clave es (pid, id) porque tras un reinicio la misma
  ejecución sigue en otro proceso. Estados:
  - `▶ corriendo`: abierta, y su proceso sigue latiendo — el runner loguea `runner vivo: …` cada
    minuto mientras sirve (`src/heartbeat.ts`); sin latido en 3 minutos, el proceso murió.
  - `⏸ pausada`: esperando un evento (el CI, un review…). Sobrevive a su proceso: vive en SQLite.
  - `✗ cortada`: su proceso murió con ella abierta (un crash o un reinicio no loguean `cierra:`) y
    nadie la retomó.
  - `↪ retomada en otro proceso`: su proceso murió, pero un reinicio la siguió — su estado es el de
    la fila del PID nuevo.
  - `✓ cerrada`.

  El estado es el del final del rango: en un rango que termina en el pasado, lo abierto se ve cortado.
- **Agentes (por ejecución)**: cada agente, cómo terminó (`→ done`, `✖ falló`, `▶ en curso`),
  cuándo arrancó, duración, tools y tools con error. De los logs: se ve en vivo, sin esperar al span.
- **Tools usadas** (locales y MCP, con sus errores), **comandos bash** y **tools que fallaron** con
  el error que recibió el modelo.
- **Trazas del issue**: una por evento; click en el trace id → el árbol completo.
- **Agentes que terminaron** (salida, quién la eligió, outcome, provider) y **requests al modelo**
  (modelo, tokens, finish reason), un span por fila.
- **Logs del issue**, en vivo, más nuevos arriba, con paso y ejecución de cada línea
  (`[implementer · a090520e] …`); en el detalle de un log, `trace_id` abre su traza.

Lo que NO muestra en vivo: un span recién se exporta cuando termina, así que un agente en pleno loop
se ve por sus logs (tools, MCP), no por su span.

## Dashboard «agentes y tools»

Sin métricas propias en el código: sale de lo que ya emiten las trazas.

- **Prometheus — span metrics que genera Tempo** (`traces_spanmetrics_*`, cualquier rango). Corridas,
  errores, % error y p50/p95 por agente (`agent <id>`), por tool (`execute_tool <name>`) y por modelo
  (`chat <model>`), más su evolución en el tiempo.
- **Tempo — TraceQL metrics** (tope de 24 h por consulta, esos paneles muestran siempre las últimas
  24 h). Lo que las span metrics no tienen: qué tools usa cada agente (con sus errores), requests por
  agente y modelo, y tokens de entrada, salida y cache por agente.
- **Loki — Bash** (cualquier rango). Programas más usados (`git`, `uv`, `sed`…), comandos completos más
  repetidos, programas por agente y su evolución; más los comandos que fallaron (Tempo, 24 h). El span
  de `bash_run` sólo trae el input crudo y TraceQL no puede cortarlo; el log `tool "bash_run"` lleva
  el mismo input (`ia_tool_input`) y LogQL lo corta con `regexp`.

Límites conocidos:

- El p95 se satura en **16.4 s**: es el último bucket del histograma de span metrics, y un agente
  suele tardar más. Para ver la cola real de un agente, sus trazas (dashboard de eventos).
- Tempo pone como `refId` de cada serie de TraceQL metrics su string de labels: por eso cada tabla de
  esos paneles es de UNA query (lo que hay que pivotear va en el `by (…)`, ej. `status`).

Los JSON de `ia-issue` e `ia-agents-tools` salen de sus generadores (`grafana/gen-*.py`): se edita
el generador, no el JSON. Grafana no siempre detecta el cambio a través del mount; después de
regenerar, recargar el provisioning (`bun run otel:dashboards` hace las tres cosas):

```bash
python3 otel/grafana/gen-agents-tools-dashboard.py otel/grafana/dashboards/ia-agents-tools.json
python3 otel/grafana/gen-issue-dashboard.py otel/grafana/dashboards/ia-issue.json
curl -u admin:admin -X POST http://localhost:3000/api/admin/provisioning/dashboards/reload
```

El runner exporta OTLP a lo que diga `settings.telemetry.endpoint` de runner.yaml (o
`OTEL_EXPORTER_OTLP_ENDPOINT`): con `http://localhost:4318`, aparece acá.

## Qué hay en una traza

Una traza por evento. Todo lo que el evento causa cuelga de ella:

```
event issue.status_changed          ia.projectId, ia.repo, ia.issue, ia.event.type
│   events: pipeline.match × N      por cada pipeline que escucha el tipo: corre o por qué no
└─ pipeline refine-technical-frontend
   └─ agent frontend-refiner        ia.agent.exit, ia.agent.outcome, ia.agent.tools
      │   event: route              salida elegida, destinos, payload
      ├─ chat claude-…              gen_ai.usage.*_tokens, finish_reasons
      │     events: mcp_tool_use / mcp_tool_result / assistant.text
      ├─ execute_tool update_prd    input, resultado, ERROR si falló
      ├─ action post_comment        ia.step.via = report:<salida>
      └─ action update_issue        ia.step.via = exit:<salida>
```

Cada span y cada log lleva el scope del evento (`ia.projectId`, `ia.repo`, `ia.issue`, `ia.pr`,
`ia.source`), el `ia.pipeline.id` y el `ia.step.id` / `ia.agent.id` del paso en el que ocurrió.

## Consultas útiles

**Tempo (TraceQL)** — Explore → Tempo:

```
{ span.ia.issue = "la-haus/lh-seller-v2-frontend#4190" }                  todo lo de un issue
{ name =~ "event .*" && span.ia.repo = "la-haus/subscriptions" }          eventos de un repo
{ span.ia.step.kind = "agent" && status = error }                         agentes que fallaron
{ span.ia.agent.exit = "to_functional" }                                  quién eligió qué salida
{ span.gen_ai.operation.name = "chat" } | select(span.gen_ai.usage.input_tokens)
```

**Loki (LogQL)** — los atributos llegan como structured metadata, con `_` en vez de `.`:

```
{service_name="ai-development-flow-runner"} | ia_issue="la-haus/lh-seller-v2-frontend#4190"
{service_name=~".+"} | ia_agent_id="frontend-refiner" | detected_level="warn"
```

Desde un log, `trace_id` enlaza a la traza; desde un span, "Logs for this span" va a Loki.

## Fuera de local

El mismo SDK apunta a cualquier backend OTLP cambiando `OTEL_EXPORTER_OTLP_ENDPOINT`: un OTel
Collector propio, o el Datadog Agent con OTLP habilitado (`4318`). Los atributos `ia.*` quedan como
tags filtrables en Datadog APM y Logs.
