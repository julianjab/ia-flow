"""Genera grafana/dashboards/ia-issue.json: todo lo de UN issue — qué está abierto ahora, sus trazas y sus logs.

    python3 apps/runner-v2/otel/grafana/gen-issue-dashboard.py \\
      apps/runner-v2/otel/grafana/dashboards/ia-issue.json
"""

import json
import sys

TEMPO = {"type": "tempo", "uid": "tempo"}
LOKI = {"type": "loki", "uid": "loki"}

# `.+` además del filtro: Loki rechaza un selector que puede matchear vacío.
# `!= ""` además: sin issue elegido, `= ""` traería todos los logs que no tienen issue.
ISSUE_LOGS = '{service_name=~".+"} | ia_issue != "" | ia_issue =~ "${issue:pipe}"'

panels = []


# Arriba va la lista de issues (y la fila "Detalle"); el detalle de un issue se arma con `y`
# relativo a su comienzo.
DETAIL_Y = 12


def add(panel, x, y, w, h, top=False):
    panel["id"] = len(panels) + 1
    panel["gridPos"] = {"x": x, "y": y if top else y + DETAIL_Y, "w": w, "h": h}
    panels.append(panel)


def tempo_search(
    title, description, query, limit=50, table_type="traces", columns=None
):
    """`columns`: {atributo: nombre} — sólo esas columnas, en ese orden (más el span id)."""
    transformations = []
    if columns:
        order = ["spanID", *columns, "status", "duration"]
        transformations.append(
            {
                "id": "organize",
                "options": {
                    "excludeByName": {
                        k: True
                        for k in (
                            "traceService",
                            "traceName",
                            "name",
                            "ia.issue",
                            "ia.step.kind",
                            "gen_ai.operation.name",
                        )
                    },
                    "indexByName": {k: i for i, k in enumerate(order)},
                    "renameByName": {
                        "spanID": "Span",
                        "status": "Estado",
                        "duration": "Duración",
                        **columns,
                    },
                },
            }
        )
    return {
        "type": "table",
        "title": title,
        "description": description,
        "datasource": TEMPO,
        "targets": [
            {
                "refId": "A",
                "datasource": TEMPO,
                "queryType": "traceql",
                "tableType": table_type,
                "limit": limit,
                "spss": 20,
                "query": query,
            }
        ],
        "transformations": transformations,
        "options": {"showHeader": True, "cellHeight": "sm", "footer": {"show": False}},
    }


# ── Ahora ──────────────────────────────────────────────────────────────────────────
# Una ejecución deja `<id> abre: …`, `se pausa …`, `se reanuda …` y `cierra: …`. La clave es
# (pid, id): tras un reinicio, la misma ejecución sigue en otro proceso. Todo se calcula en LogQL:
# las transformaciones de Grafana no pueden restar una columna vacía.
#
# Abierta = abrió y no cerró (`unless`). Pero un proceso que muere (crash, reinicio) nunca loguea
# su `cierra:`: por eso el runner late (`runner vivo: …` cada minuto, src/heartbeat.ts), y una
# abierta corre sólo si su proceso latió en los últimos 3 minutos. El estado es el del final del
# rango (una query instantánea).
ALIVE = 'sum by (process_pid) (count_over_time({service_name=~".+"} |= "runner vivo:" [3m]))'


def execution_states(logs, by):
    """Las ejecuciones (`by` incluye process_pid, ia_execution_id) por estado, desde `logs`."""
    exec_logs = f'{logs} | ia_execution_id != ""'

    def phase(p):
        return f'sum by ({by}) (count_over_time({exec_logs} |= " {p}" [$__range]))'

    opened, closed = phase("abre:"), phase("cierra:")
    # pausas − reanudaciones: > 0 pausada, ≤ 0 corriendo (si está abierta)
    balance = f'(({phase("se pausa ")} or {opened} * 0) - ({phase("se reanuda ")} or {opened} * 0))'
    open_ = f"({balance} unless {closed})"
    dead = f"({open_} unless on (process_pid) {ALIVE})"
    last_row = f"max by ({by}) (max_over_time({exec_logs} | unwrap observed_timestamp [$__range]))"
    last_exec = (
        "max by (ia_execution_id) (max_over_time("
        f"{exec_logs} | unwrap observed_timestamp [$__range]))"
    )
    # abierta en un proceso muerto, y la ejecución siguió después en otro: la retomó un reinicio
    moved = f"({dead} and ({last_row} < on (ia_execution_id) group_left {last_exec}))"
    return {
        "running": f"(({open_} <= 0) and on (process_pid) {ALIVE})",
        # una pausa sobrevive a su proceso (vive en SQLite): sigue pausada salvo que otro la retome
        "paused": f"(({open_} > 0) unless {moved})",
        "cut": f"(({dead} <= 0) unless {moved})",
        "moved": moved,
        "closed": closed,
    }


EXEC_STATES = execution_states(ISSUE_LOGS, "process_pid, ia_execution_id")


def loki_instant(ref, expr):
    return {"refId": ref, "datasource": LOKI, "queryType": "instant", "expr": expr}


# ── Issues ─────────────────────────────────────────────────────────────────────────
# Una fila por issue con actividad en el rango. Todo por issue desde los logs (llevan `ia_issue`).
ANY_ISSUE = '{service_name=~".+"} | ia_issue != ""'


def issue_phase(phase):
    return (
        "sum by (ia_issue, process_pid, ia_execution_id) (count_over_time("
        f'{ANY_ISSUE} | ia_execution_id != "" |= " {phase}" [$__range]))'
    )


# Por ejecución: 1000000 si corre, 1000 si está pausada, 1 si quedó cortada; sumado por issue,
# ≥ 1000000 = algo corre, ≥ 1000 = algo espera, ≥ 1 = sólo quedan cortadas.
# Todo issue con actividad en el rango; `or ALL * 0` completa con 0 lo que otra query no trae, así
# la columna no desaparece (0 = inactivo, 0 eventos…).
ALL_ISSUES = f"sum by (ia_issue) (count_over_time({ANY_ISSUE} [$__range]))"
_I = execution_states(ANY_ISSUE, "ia_issue, process_pid, ia_execution_id")
ISSUE_STATE = (
    f'sum by (ia_issue) (({_I["running"]} * 0 + 1000000) or ({_I["paused"]} * 0 + 1000)'
    f' or ({_I["cut"]} * 0 + 1))'
    f" or {ALL_ISSUES} * 0"
)


def issue_count(filter_):
    return f"sum by (ia_issue) (count_over_time({ANY_ISSUE} {filter_} [$__range])) or {ALL_ISSUES} * 0"


add(
    {
        "type": "table",
        "title": "Issues (click en uno → su detalle abajo)",
        "description": "Cada issue con actividad en el rango. `Estado`: ▶ corriendo (una ejecución "
        "abierta en un runner que sigue latiendo), ⏸ pausada (esperando un evento: el CI, un "
        "review…), ✗ cortada (quedó abierta en un proceso que murió y nadie la retomó) o inactivo. "
        "`Eventos`: cuántos "
        "llegaron; `Pasos de agente`: cuántas veces terminó un agente; `Errores`: logs de error.",
        "datasource": LOKI,
        "targets": [
            loki_instant(
                "A",
                "max by (ia_issue) (max_over_time("
                f"{ANY_ISSUE} | unwrap observed_timestamp [$__range])) / 1000000",
            ),
            loki_instant("B", ISSUE_STATE),
            loki_instant("C", issue_count('|~ "^evento \\".*\\": (corren|ninguna)"')),
            loki_instant(
                "D", issue_count('|~ "^agente \\".*\\" (eligió|terminó sin salida)"')
            ),
            loki_instant("E", issue_count('| detected_level = "error"')),
        ],
        "transformations": [
            {"id": "labelsToFields", "options": {"mode": "columns"}},
            {"id": "merge", "options": {}},
            {
                "id": "organize",
                "options": {
                    "excludeByName": {"Time": True},
                    "indexByName": {
                        "ia_issue": 0,
                        "Value #B": 1,
                        "Value #A": 2,
                        "Value #C": 3,
                        "Value #D": 4,
                        "Value #E": 5,
                    },
                    "renameByName": {
                        "ia_issue": "Issue",
                        "Value #B": "Estado",
                        "Value #A": "Última actividad",
                        "Value #C": "Eventos",
                        "Value #D": "Pasos de agente",
                        "Value #E": "Errores",
                    },
                },
            },
            {
                "id": "sortBy",
                "options": {"sort": [{"field": "Última actividad", "desc": True}]},
            },
        ],
        "fieldConfig": {
            "defaults": {
                "custom": {
                    "align": "auto",
                    "cellOptions": {"type": "auto"},
                    "minWidth": 60,
                },
                "decimals": 0,
                "noValue": "0",
            },
            "overrides": [
                {
                    "matcher": {"id": "byName", "options": "Issue"},
                    "properties": [
                        {"id": "custom.width", "value": 340},
                        {
                            "id": "links",
                            "value": [
                                {
                                    "title": "Ver el detalle de ${__value.raw}",
                                    "url": "/d/ia-issue?${__url_time_range}"
                                    "&var-issue=${__value.raw:percentencode}",
                                }
                            ],
                        },
                    ],
                },
                {
                    "matcher": {"id": "byName", "options": "Estado"},
                    "properties": [
                        {
                            "id": "mappings",
                            "value": [
                                {
                                    "type": "value",
                                    "options": {
                                        "0": {"text": "· inactivo", "color": "text"}
                                    },
                                },
                                {
                                    "type": "range",
                                    "options": {
                                        "from": 1000000,
                                        "to": 1e12,
                                        "result": {
                                            "text": "▶ corriendo",
                                            "color": "green",
                                        },
                                    },
                                },
                                {
                                    "type": "range",
                                    "options": {
                                        "from": 1000,
                                        "to": 999999,
                                        "result": {
                                            "text": "⏸ pausada",
                                            "color": "orange",
                                        },
                                    },
                                },
                                {
                                    "type": "range",
                                    "options": {
                                        "from": 1,
                                        "to": 999,
                                        "result": {"text": "✗ cortada", "color": "red"},
                                    },
                                },
                            ],
                        },
                        {"id": "custom.cellOptions", "value": {"type": "color-text"}},
                    ],
                },
                {
                    "matcher": {"id": "byName", "options": "Última actividad"},
                    "properties": [{"id": "unit", "value": "dateTimeFromNow"}],
                },
                {
                    "matcher": {"id": "byName", "options": "Errores"},
                    "properties": [
                        {
                            "id": "thresholds",
                            "value": {
                                "mode": "absolute",
                                "steps": [
                                    {"color": "text", "value": None},
                                    {"color": "red", "value": 1},
                                ],
                            },
                        },
                        {"id": "custom.cellOptions", "value": {"type": "color-text"}},
                    ],
                },
            ],
        },
        "options": {"showHeader": True, "cellHeight": "sm", "footer": {"show": False}},
    },
    0,
    0,
    24,
    11,
    top=True,
)
add(
    {"type": "row", "title": "Detalle — $issue", "collapsed": False, "panels": []},
    0,
    11,
    24,
    1,
    top=True,
)

# ── Filtros del detalle ────────────────────────────────────────────────────────────
# `$agent`: el selector de arriba o un click ("All" vale `.*`). `$execution`: un click en una
# ejecución (vacío + `.*` = todas).
DETAIL_LOGS = (
    f'{ISSUE_LOGS} | ia_agent_id =~ "${{agent:pipe}}" | ia_execution_id =~ "$execution.*"'
)
# Lo que loguea cada paso de agente (lleva `ia_agent_id`).
AGENT_LOGS = f'{DETAIL_LOGS} | ia_agent_id != ""'
# Una llamada a una tool deja `tool "X"` (o `tool MCP "srv.X"`) y, si falló, `tool "X" devolvió
# error: …`. `regexp` saca el nombre con el server MCP incluido (`github-mcp.issue_read`).
TOOL_NAME = r' | regexp "^tool (?:MCP )?\"(?P<tool>[^\"]+)\""'
TOOL_CALLS = AGENT_LOGS + r' |~ "^tool (MCP )?\"[^\"]+\"$"' + TOOL_NAME
TOOL_ERRORS = AGENT_LOGS + r' |~ "^tool (MCP )?\"[^\"]+\" devolvió error"' + TOOL_NAME
# `agente "X" eligió "done" → …`, `agente "X" terminó sin salida`, `paso "X" falló: …`.
AGENT_END = (
    AGENT_LOGS
    + r' |~ "^(agente|paso) \""'
    + r' | regexp "(?P<exit>eligió \"[^\"]+\"|terminó sin salida|falló)"'
)
# El input de `bash_run` viaja como structured metadata (`ia_tool_input`); LogQL lo corta.
# `(?:[^"\\]|\\.)*`: un `\"` dentro del comando (`git commit -m \"…\"`) no lo corta.
BASH_COMMANDS = (
    f'{AGENT_LOGS} |= "bash_run" | gen_ai_tool_name = "bash_run" | ia_tool_input != ""'
    ' | line_format "{{.ia_tool_input}}"'
    r' | regexp "\"command\":\"(?P<command>(?:[^\"\\\\]|\\\\.)*)\"" | command != ""'
)
STEP = "ia_execution_id, ia_pipeline_id, ia_agent_id"


def stat(title, description, expr, color="blue", thresholds=None):
    return {
        "type": "stat",
        "title": title,
        "description": description,
        "datasource": LOKI,
        "targets": [loki_instant("A", expr)],
        "fieldConfig": {
            "defaults": {
                "decimals": 0,
                "noValue": "0",
                "color": {
                    "mode": "fixed" if not thresholds else "thresholds",
                    "fixedColor": color,
                },
                "thresholds": thresholds
                or {"mode": "absolute", "steps": [{"color": color, "value": None}]},
            },
            "overrides": [],
        },
        "options": {
            "reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False},
            "colorMode": "value",
            "graphMode": "none",
            "textMode": "value",
            "justifyMode": "center",
        },
    }


RED_IF_ANY = {
    "mode": "absolute",
    "steps": [{"color": "green", "value": None}, {"color": "red", "value": 1}],
}


def link_to(var, title):
    """Click en la celda → el mismo issue con `var` puesto (filtra el resto del detalle)."""
    return {
        "id": "links",
        "value": [
            {
                "title": title,
                "url": "/d/ia-issue?${__url_time_range}&${issue:queryparam}"
                + "".join(
                    f"&${{{v}:queryparam}}" for v in ("agent", "execution") if v != var
                )
                + f"&var-{var}=${{__value.raw:percentencode}}",
            }
        ],
    }


# ── Resumen ────────────────────────────────────────────────────────────────────────
# Todo desde Loki: los logs salen en vivo, un span recién cuando termina.
for i, (title, description, expr, color, thresholds) in enumerate(
    (
        (
            "Pasos de agente",
            "Veces que un agente terminó (eligió una salida, terminó sin salida o falló).",
            f"sum(count_over_time({AGENT_END} [$__range]))",
            "purple",
            None,
        ),
        (
            "Llamadas a tools",
            "Tools que llamaron los agentes (locales y MCP).",
            f"sum(count_over_time({TOOL_CALLS} [$__range]))",
            "blue",
            None,
        ),
        (
            "Tools que fallaron",
            "Llamadas a tools que devolvieron error al modelo (comando denegado, input inválido…).",
            f"sum(count_over_time({TOOL_ERRORS} [$__range]))",
            "orange",
            {
                "mode": "absolute",
                "steps": [
                    {"color": "green", "value": None},
                    {"color": "orange", "value": 1},
                ],
            },
        ),
        (
            "Comandos bash",
            "Comandos que corrió `bash_run`.",
            f"sum(count_over_time({BASH_COMMANDS} [$__range]))",
            "text",
            None,
        ),
        (
            "Errores",
            "Logs de error: requests al modelo que fallaron, pasos o acciones que fallaron.",
            f'sum(count_over_time({DETAIL_LOGS} | detected_level = "error" [$__range]))',
            "red",
            RED_IF_ANY,
        ),
    )
):
    add(
        stat(title, description, expr, color, thresholds),
        [0, 5, 10, 15, 20][i],
        0,
        5 if i < 4 else 4,
        4,
    )

# ── Ejecuciones ────────────────────────────────────────────────────────────────────
# Todas las del issue en el rango, abiertas y cerradas. La clave es (pid, id): tras un reinicio,
# la misma ejecución sigue en otro proceso. Sin los filtros de agente/ejecución: es la lista para elegir.
EXEC = "process_pid, ia_execution_id"
EXEC_LOGS = f'{ISSUE_LOGS} | ia_execution_id != ""'


def or_zero(expr):
    """`or … * 0`: la ejecución aparece con 0 aunque no tenga lo que se cuenta."""
    return f"({expr}) or sum by ({EXEC}) (count_over_time({EXEC_LOGS} [$__range])) * 0"


add(
    {
        "type": "table",
        "title": "Ejecuciones del issue — click en una → filtra el detalle a ella",
        "description": "Cada ejecución del issue en el rango: qué pipeline abrió, cuándo, cuánto lleva o "
        "duró, en qué estado está (`▶ corriendo`, `⏸ pausada` esperando un evento, `✓ cerrada`, "
        "`✗ cortada` si su proceso murió con ella abierta, `↪ retomada` si un reinicio la siguió en "
        "otro proceso — su fila es la del PID nuevo) y con "
        "qué resultado cerró (`done`, `superseded`…), qué evento la abrió (`La abrió`), cuánto esperó "
        "en cola a que la task se liberara, y sus pasos de agente, tools y errores. El porqué de cada "
        "una está en «Por qué pasó». `▶ corriendo` exige que su proceso siga latiendo "
        "(`runner vivo:` cada minuto).",
        "datasource": LOKI,
        "targets": [
            loki_instant(
                "A",
                # `ia_event_type`: el evento que la abrió (el log `abre:` corre dentro de ese evento).
                f'min by ({EXEC}, pipeline, ia_event_type) (min_over_time({EXEC_LOGS} |= " abre:"'
                ' | regexp "abre: (?P<pipeline>[^ ]+)" | unwrap observed_timestamp [$__range])) / 1000000',
            ),
            loki_instant(
                "B",
                f"max by ({EXEC}) (max_over_time({EXEC_LOGS} | unwrap observed_timestamp [$__range])) / 1000000",
            ),
            # `abre: build-reentry (esperó 55534 ms)`: cuánto esperó en cola a que la task se liberara.
            loki_instant(
                "H",
                f'max by ({EXEC}) (max_over_time({EXEC_LOGS} |= " abre:"'
                ' | regexp "esperó (?P<waited>[0-9]+) ms" | unwrap waited [$__range]))',
            ),
            # ≤ 0 corriendo, 1…999 pausada, 1000 cerrada, 2000 cortada, 3000 retomada en otro.
            loki_instant(
                "C",
                f'{EXEC_STATES["running"]} or {EXEC_STATES["paused"]}'
                f' or ({EXEC_STATES["cut"]} * 0 + 2000) or ({EXEC_STATES["moved"]} * 0 + 3000)'
                f' or ({EXEC_STATES["closed"]} * 0 + 1000)',
            ),
            loki_instant(
                "D",
                f'sum by ({EXEC}, result) (count_over_time({EXEC_LOGS} |= " cierra:"'
                ' | regexp "cierra: (?P<result>[^ ]+)" [$__range]))',
            ),
            loki_instant(
                "E",
                or_zero(
                    f'sum by ({EXEC}) (count_over_time({EXEC_LOGS} | ia_agent_id != ""'
                    + r' |~ "^(agente|paso) \"" [$__range]))'
                ),
            ),
            loki_instant(
                "F",
                or_zero(
                    f'sum by ({EXEC}) (count_over_time({EXEC_LOGS} | ia_agent_id != ""'
                    + r' |~ "^tool (MCP )?\"[^\"]+\"$" [$__range]))'
                ),
            ),
            loki_instant(
                "G",
                or_zero(
                    f'sum by ({EXEC}) (count_over_time({EXEC_LOGS} | detected_level = "error" [$__range]))'
                ),
            ),
        ],
        "transformations": [
            {"id": "labelsToFields", "options": {"mode": "columns"}},
            {"id": "merge", "options": {}},
            {
                "id": "calculateField",
                "options": {
                    "mode": "binary",
                    "alias": "Duración",
                    "binary": {
                        "left": "Value #B",
                        "operator": "-",
                        "right": "Value #A",
                    },
                },
            },
            {
                "id": "organize",
                "options": {
                    "excludeByName": {"Time": True, "Value #B": True, "Value #D": True},
                    "indexByName": {
                        "ia_execution_id": 0,
                        "pipeline": 1,
                        "ia_event_type": 2,
                        "Value #C": 3,
                        "result": 4,
                        "Value #A": 5,
                        "Value #H": 6,
                        "Duración": 7,
                        "Value #E": 8,
                        "Value #F": 9,
                        "Value #G": 10,
                        "process_pid": 11,
                    },
                    "renameByName": {
                        "ia_execution_id": "Ejecución",
                        "pipeline": "Pipeline",
                        "ia_event_type": "La abrió",
                        "Value #H": "Esperó en cola",
                        "Value #C": "Estado",
                        "result": "Resultado",
                        "Value #A": "Abrió",
                        "Value #E": "Pasos de agente",
                        "Value #F": "Tools",
                        "Value #G": "Errores",
                        "process_pid": "PID",
                    },
                },
            },
            {"id": "sortBy", "options": {"sort": [{"field": "Abrió", "desc": True}]}},
        ],
        "fieldConfig": {
            "defaults": {
                "custom": {
                    "align": "auto",
                    "cellOptions": {"type": "auto"},
                    "minWidth": 60,
                },
                "decimals": 0,
                "noValue": "—",
            },
            "overrides": [
                {
                    "matcher": {"id": "byName", "options": "Estado"},
                    "properties": [
                        {
                            "id": "mappings",
                            "value": [
                                {
                                    "type": "value",
                                    "options": {
                                        "1000": {"text": "✓ cerrada", "color": "text"},
                                        "2000": {
                                            "text": "✗ cortada (su proceso murió)",
                                            "color": "red",
                                        },
                                        "3000": {
                                            "text": "↪ retomada en otro proceso",
                                            "color": "blue",
                                        },
                                    },
                                },
                                {
                                    "type": "range",
                                    "options": {
                                        "from": 1,
                                        "to": 999,
                                        "result": {
                                            "text": "⏸ pausada",
                                            "color": "orange",
                                        },
                                    },
                                },
                                {
                                    "type": "range",
                                    "options": {
                                        "from": -1e9,
                                        "to": 0,
                                        "result": {
                                            "text": "▶ corriendo",
                                            "color": "green",
                                        },
                                    },
                                },
                            ],
                        },
                        {"id": "custom.cellOptions", "value": {"type": "color-text"}},
                    ],
                },
                {
                    "matcher": {"id": "byName", "options": "Abrió"},
                    "properties": [{"id": "unit", "value": "dateTimeAsLocal"}],
                },
                {
                    "matcher": {"id": "byName", "options": "Esperó en cola"},
                    "properties": [
                        {"id": "unit", "value": "ms"},
                        {"id": "decimals", "value": 1},
                    ],
                },
                {
                    "matcher": {"id": "byName", "options": "Duración"},
                    "properties": [
                        {"id": "unit", "value": "ms"},
                        {"id": "decimals", "value": 1},
                    ],
                },
                {
                    "matcher": {"id": "byName", "options": "Errores"},
                    "properties": [
                        {
                            "id": "thresholds",
                            "value": {
                                "mode": "absolute",
                                "steps": [
                                    {"color": "text", "value": None},
                                    {"color": "red", "value": 1},
                                ],
                            },
                        },
                        {"id": "custom.cellOptions", "value": {"type": "color-text"}},
                    ],
                },
                {
                    "matcher": {"id": "byName", "options": "Ejecución"},
                    "properties": [
                        link_to("execution", "Filtrar el detalle a esta ejecución")
                    ],
                },
            ],
        },
        "options": {"showHeader": True, "cellHeight": "sm", "footer": {"show": False}},
    },
    0,
    4,
    24,
    8,
)
add(
    {
        "type": "timeseries",
        "title": "Actividad del issue",
        "description": "Logs del issue por nivel: cuándo pasó algo, y cuándo algo falló.",
        "datasource": LOKI,
        "interval": "5m",
        "targets": [
            {
                "refId": "A",
                "datasource": LOKI,
                "queryType": "range",
                "expr": f"sum by (detected_level) (count_over_time({DETAIL_LOGS} [$__interval]))",
                "legendFormat": "{{detected_level}}",
            }
        ],
        "fieldConfig": {
            "defaults": {
                "decimals": 0,
                "custom": {
                    "drawStyle": "bars",
                    "fillOpacity": 80,
                    "stacking": {"mode": "normal", "group": "A"},
                    "showPoints": "never",
                },
            },
            "overrides": [
                {
                    "matcher": {"id": "byName", "options": name},
                    "properties": [
                        {"id": "color", "value": {"mode": "fixed", "fixedColor": color}}
                    ],
                }
                for name, color in (
                    ("info", "blue"),
                    ("warn", "orange"),
                    ("error", "red"),
                    ("debug", "text"),
                )
            ],
        },
        "options": {
            "legend": {"displayMode": "list", "placement": "bottom"},
            "tooltip": {"mode": "multi"},
        },
    },
    14,
    12,
    10,
    8,
)

# ── Por qué ────────────────────────────────────────────────────────────────────────
# Las decisiones del engine, en orden: qué evento llegó, qué pipeline corrió (o por qué ninguna),
# qué esperó en cola, qué reemplazó a qué, cuándo abrió/pausó/cerró cada ejecución.
DECISIONS = (
    r"^evento \"|abre: | cierra: | se pausa | se reanuda |en cola para|quedó reemplazada"
    r"|^agente \"|^paso \"|falló"
)
add(
    {
        "type": "logs",
        "title": "Por qué pasó — decisiones del engine (qué evento, qué pipeline, qué reemplazó a qué)",
        "description": "Sólo las líneas del engine que explican las ejecuciones: cada evento y qué "
        "pipelines corrieron (o `ninguna`), cuándo una esperó porque la task estaba ocupada, cuándo "
        "una en cola quedó reemplazada por otra más nueva, y cuándo cada ejecución abrió, se pausó "
        "y cerró. Una `cierra: superseded` la cerró la ejecución que abre en la línea siguiente.",
        "datasource": LOKI,
        "targets": [
            {
                "refId": "A",
                "datasource": LOKI,
                "queryType": "range",
                "expr": f'{ISSUE_LOGS} | ia_execution_id =~ "$execution.*" |~ "{DECISIONS}"'
                ' | line_format "{{ .ia_event_type }} · {{ __line__ }}"',
            }
        ],
        "options": {
            "showTime": True,
            "wrapLogMessage": True,
            "sortOrder": "Descending",
            "enableLogDetails": True,
            "dedupStrategy": "none",
        },
    },
    0,
    12,
    14,
    8,
)

# ── Agentes ────────────────────────────────────────────────────────────────────────
# Una fila por (ejecución, pipeline, agente), desde los logs: se ve en vivo, sin esperar al span.
add(
    {
        "type": "table",
        "title": "Agentes (por ejecución) — click en el agente o la ejecución → filtra el detalle",
        "description": "Cada agente que corrió en el rango: cuándo arrancó (su primer log) y cuándo "
        "logueó por última vez, cuántas tools llamó, cuántas fallaron, y cómo terminó. `▶ en curso` = "
        "todavía no eligió salida (o murió sin cerrar).",
        "datasource": LOKI,
        "targets": [
            loki_instant(
                "A",
                f"min by ({STEP}) (min_over_time({AGENT_LOGS} | unwrap observed_timestamp [$__range])) / 1000000",
            ),
            loki_instant(
                "B",
                f"max by ({STEP}) (max_over_time({AGENT_LOGS} | unwrap observed_timestamp [$__range])) / 1000000",
            ),
            loki_instant(
                "C",
                f"sum by ({STEP}) (count_over_time({TOOL_CALLS} [$__range]))"
                f" or sum by ({STEP}) (count_over_time({AGENT_LOGS} [$__range])) * 0",
            ),
            loki_instant(
                "D",
                f"sum by ({STEP}) (count_over_time({TOOL_ERRORS} [$__range]))"
                f" or sum by ({STEP}) (count_over_time({AGENT_LOGS} [$__range])) * 0",
            ),
            loki_instant(
                "E", f"sum by ({STEP}, exit) (count_over_time({AGENT_END} [$__range]))"
            ),
        ],
        "transformations": [
            {"id": "labelsToFields", "options": {"mode": "columns"}},
            {"id": "merge", "options": {}},
            {
                "id": "calculateField",
                "options": {
                    "mode": "binary",
                    "alias": "Duración",
                    "binary": {
                        "left": "Value #B",
                        "operator": "-",
                        "right": "Value #A",
                    },
                },
            },
            {
                "id": "organize",
                "options": {
                    "excludeByName": {"Time": True, "Value #B": True, "Value #E": True},
                    "indexByName": {
                        "ia_agent_id": 0,
                        "exit": 1,
                        "Value #A": 2,
                        "Duración": 3,
                        "Value #C": 4,
                        "Value #D": 5,
                        "ia_pipeline_id": 6,
                        "ia_execution_id": 7,
                    },
                    "renameByName": {
                        "ia_agent_id": "Agente",
                        "exit": "Terminó",
                        "Value #A": "Arrancó",
                        "Value #C": "Tools",
                        "Value #D": "Tools con error",
                        "ia_pipeline_id": "Pipeline",
                        "ia_execution_id": "Ejecución",
                    },
                },
            },
            {"id": "sortBy", "options": {"sort": [{"field": "Arrancó", "desc": True}]}},
        ],
        "fieldConfig": {
            "defaults": {
                "custom": {
                    "align": "auto",
                    "cellOptions": {"type": "auto"},
                    "minWidth": 60,
                },
                "decimals": 0,
            },
            "overrides": [
                {
                    "matcher": {"id": "byName", "options": "Arrancó"},
                    "properties": [{"id": "unit", "value": "dateTimeAsLocal"}],
                },
                {
                    "matcher": {"id": "byName", "options": "Duración"},
                    "properties": [
                        {"id": "unit", "value": "ms"},
                        {"id": "decimals", "value": 1},
                    ],
                },
                {
                    "matcher": {"id": "byName", "options": "Terminó"},
                    "properties": [
                        {"id": "noValue", "value": "▶ en curso"},
                        {
                            "id": "mappings",
                            "value": [
                                {
                                    "type": "regex",
                                    "options": {
                                        "pattern": '^eligió "(.*)"$',
                                        "result": {"text": "→ $1", "color": "green"},
                                    },
                                },
                                {
                                    "type": "value",
                                    "options": {
                                        "falló": {"text": "✖ falló", "color": "red"}
                                    },
                                },
                                {
                                    "type": "value",
                                    "options": {
                                        "terminó sin salida": {
                                            "text": "⚠ sin salida",
                                            "color": "orange",
                                        }
                                    },
                                },
                            ],
                        },
                        {"id": "custom.cellOptions", "value": {"type": "color-text"}},
                    ],
                },
                {
                    "matcher": {"id": "byName", "options": "Tools con error"},
                    "properties": [
                        {
                            "id": "thresholds",
                            "value": {
                                "mode": "absolute",
                                "steps": [
                                    {"color": "text", "value": None},
                                    {"color": "orange", "value": 1},
                                ],
                            },
                        },
                        {"id": "custom.cellOptions", "value": {"type": "color-text"}},
                    ],
                },
                {
                    "matcher": {"id": "byName", "options": "Agente"},
                    "properties": [
                        link_to("agent", "Filtrar el detalle a este agente")
                    ],
                },
                {
                    "matcher": {"id": "byName", "options": "Ejecución"},
                    "properties": [
                        link_to("execution", "Filtrar el detalle a esta ejecución")
                    ],
                },
            ],
        },
        "options": {"showHeader": True, "cellHeight": "sm", "footer": {"show": False}},
    },
    0,
    20,
    24,
    8,
)

# ── Tools ──────────────────────────────────────────────────────────────────────────
add(
    {
        "type": "table",
        "title": "Tools usadas",
        "description": "Qué tools llamó cada agente y cuántas veces fallaron. Las MCP llevan el server "
        "(`github-mcp.issue_read`). Click en la tool → sus logs.",
        "datasource": LOKI,
        "targets": [
            loki_instant(
                "A",
                f"sum by (ia_agent_id, tool) (count_over_time({TOOL_CALLS} [$__range]))",
            ),
            loki_instant(
                "B",
                f"sum by (ia_agent_id, tool) (count_over_time({TOOL_ERRORS} [$__range]))"
                f" or sum by (ia_agent_id, tool) (count_over_time({TOOL_CALLS} [$__range])) * 0",
            ),
        ],
        "transformations": [
            {"id": "labelsToFields", "options": {"mode": "columns"}},
            {"id": "merge", "options": {}},
            {
                "id": "organize",
                "options": {
                    "excludeByName": {"Time": True},
                    "indexByName": {
                        "tool": 0,
                        "Value #A": 1,
                        "Value #B": 2,
                        "ia_agent_id": 3,
                    },
                    "renameByName": {
                        "tool": "Tool",
                        "Value #A": "Llamadas",
                        "Value #B": "Errores",
                        "ia_agent_id": "Agente",
                    },
                },
            },
            {
                "id": "sortBy",
                "options": {"sort": [{"field": "Llamadas", "desc": True}]},
            },
        ],
        "fieldConfig": {
            "defaults": {
                "custom": {
                    "align": "auto",
                    "cellOptions": {"type": "auto"},
                    "minWidth": 50,
                },
                "decimals": 0,
                "noValue": "0",
            },
            "overrides": [
                {
                    "matcher": {"id": "byName", "options": "Llamadas"},
                    "properties": [
                        {
                            "id": "custom.cellOptions",
                            "value": {
                                "type": "gauge",
                                "mode": "basic",
                                "valueDisplayMode": "text",
                            },
                        },
                        {
                            "id": "color",
                            "value": {"mode": "fixed", "fixedColor": "blue"},
                        },
                    ],
                },
                {
                    "matcher": {"id": "byName", "options": "Errores"},
                    "properties": [
                        {
                            "id": "thresholds",
                            "value": {
                                "mode": "absolute",
                                "steps": [
                                    {"color": "text", "value": None},
                                    {"color": "orange", "value": 1},
                                ],
                            },
                        },
                        {"id": "custom.cellOptions", "value": {"type": "color-text"}},
                    ],
                },
                {
                    "matcher": {"id": "byName", "options": "Tool"},
                    "properties": [link_to("search", "Logs de esta tool")],
                },
            ],
        },
        "options": {"showHeader": True, "cellHeight": "sm", "footer": {"show": False}},
    },
    0,
    28,
    8,
    10,
)
add(
    {
        "type": "table",
        "title": "Comandos bash",
        "description": "Los comandos que corrió `bash_run`, los más repetidos arriba.",
        "datasource": LOKI,
        "targets": [
            loki_instant(
                "A",
                f"sum by (ia_agent_id, command) (count_over_time({BASH_COMMANDS} [$__range]))",
            )
        ],
        "transformations": [
            {"id": "labelsToFields", "options": {"mode": "columns"}},
            {
                "id": "organize",
                "options": {
                    "excludeByName": {"Time": True},
                    "indexByName": {"command": 0, "Value": 1, "ia_agent_id": 2},
                    "renameByName": {
                        "command": "Comando",
                        "Value": "Veces",
                        "ia_agent_id": "Agente",
                    },
                },
            },
            {"id": "sortBy", "options": {"sort": [{"field": "Veces", "desc": True}]}},
        ],
        "fieldConfig": {
            "defaults": {
                "custom": {
                    "align": "auto",
                    "cellOptions": {"type": "auto"},
                    "minWidth": 50,
                },
                "decimals": 0,
            },
            "overrides": [
                {
                    "matcher": {"id": "byName", "options": "Comando"},
                    "properties": [{"id": "custom.width", "value": 420}],
                }
            ],
        },
        "options": {"showHeader": True, "cellHeight": "sm", "footer": {"show": False}},
    },
    8,
    28,
    8,
    10,
)
add(
    {
        "type": "logs",
        "title": "Tools que fallaron (y qué devolvieron)",
        "description": "Cada llamada a una tool que devolvió error al modelo, con el error completo.",
        "datasource": LOKI,
        "targets": [
            {
                "refId": "A",
                "datasource": LOKI,
                "queryType": "range",
                "expr": TOOL_ERRORS
                + ' | line_format "[{{ .ia_agent_id }}] {{ __line__ }}"',
            }
        ],
        "options": {
            "showTime": True,
            "wrapLogMessage": True,
            "sortOrder": "Descending",
            "enableLogDetails": True,
            "dedupStrategy": "none",
        },
    },
    16,
    28,
    8,
    10,
)

# ── Trazas ─────────────────────────────────────────────────────────────────────────
add(
    tempo_search(
        "Trazas del issue (una por evento)",
        "Cada evento que llegó para el issue y todo lo que causó. Click en el trace id → el árbol "
        "completo: evento → pipeline → agente → requests al modelo y tools.",
        '{ name =~ "event .*" && span.ia.issue =~ "${issue:pipe}" }',
        limit=100,
    ),
    0,
    38,
    24,
    8,
)
add(
    tempo_search(
        "Agentes que terminaron (spans) — salida, outcome, provider",
        "Un span por paso de agente, cuando termina: salida elegida, quién la eligió (`exit_origin`), "
        "outcome, provider y duración. Un agente en curso todavía no tiene span (ver la tabla de arriba).",
        '{ span.ia.step.kind = "agent" && span.ia.issue =~ "${issue:pipe}" && span.ia.agent.id =~ "${agent:pipe}" }'
        " | select(span.ia.agent.id, span.ia.agent.exit, span.ia.agent.exit_origin, span.ia.agent.outcome,"
        " span.ia.agent.provider, span.ia.pipeline.id, span.ia.execution.id, status, duration)",
        table_type="spans",
        columns={
            "ia.agent.id": "Agente",
            "ia.agent.exit": "Salida",
            "ia.agent.exit_origin": "La eligió",
            "ia.agent.outcome": "Outcome",
            "ia.agent.provider": "Provider",
            "ia.pipeline.id": "Pipeline",
            "ia.execution.id": "Ejecución",
        },
    ),
    0,
    46,
    12,
    9,
)
add(
    tempo_search(
        "Requests al modelo",
        "Cada request a la API: agente, modelo, tokens y por qué terminó.",
        '{ span.gen_ai.operation.name = "chat" && span.ia.issue =~ "${issue:pipe}" && span.ia.agent.id =~ "${agent:pipe}" }'
        " | select(span.ia.agent.id, span.gen_ai.request.model, span.gen_ai.usage.input_tokens,"
        " span.gen_ai.usage.output_tokens, span.gen_ai.usage.cache_read_input_tokens,"
        " span.gen_ai.response.finish_reasons, duration)",
        table_type="spans",
        columns={
            "ia.agent.id": "Agente",
            "gen_ai.request.model": "Modelo",
            "gen_ai.usage.input_tokens": "Input",
            "gen_ai.usage.output_tokens": "Output",
            "gen_ai.usage.cache_read_input_tokens": "Cache read",
            "gen_ai.response.finish_reasons": "Fin",
        },
    ),
    12,
    46,
    12,
    9,
)

# ── Logs ───────────────────────────────────────────────────────────────────────────
add(
    {
        "type": "logs",
        "title": "Logs del issue (más nuevos arriba · click en un log → trace_id → la traza)",
        "description": "Todo lo que loguearon el engine, los agentes, el provider y las tools para el "
        "issue. Cada línea dice su paso y ejecución (`[implementer · a090520e]`); en el detalle, "
        "`trace_id` abre su traza. `Buscar` filtra por texto; `Ruido` esconde líneas de tools.",
        "datasource": LOKI,
        "targets": [
            {
                "refId": "A",
                "datasource": LOKI,
                "queryType": "range",
                "expr": f'{DETAIL_LOGS} |~ "(?i)$search" !~ "$noise"'
                ' | line_format "{{ if .ia_step_id }}[{{ .ia_step_id }}{{ if .ia_execution_id }} · '
                '{{ trunc 8 .ia_execution_id }}{{ end }}] {{ end }}{{ __line__ }}"',
            }
        ],
        "options": {
            "showTime": True,
            "wrapLogMessage": True,
            "sortOrder": "Descending",
            "enableLogDetails": True,
            "dedupStrategy": "none",
            "prettifyLogMessage": False,
        },
    },
    0,
    55,
    24,
    18,
)


def tempo_values(name, label, attribute, filter_="", all_=False):
    # multi: varios valores a la vez; las queries los usan como regex con `${var:pipe}` (`a|b`, sin
    # escapar: el formato por defecto de un multi sería `{a,b}`, que LogQL/TraceQL no entienden).
    var = {
        "name": name,
        "label": label,
        "type": "query",
        "datasource": TEMPO,
        # type 1 = valores de un atributo; `query` los filtra con TraceQL.
        "query": {
            "refId": "TempoDatasourceVariableQueryEditor-VariableQuery",
            "type": 1,
            "label": attribute,
            "query": filter_,
        },
        "refresh": 2,
        "sort": 1,
        "allowCustomValue": True,
        "multi": True,
        "current": {},
    }
    if all_:
        var |= {
            "includeAll": True,
            "allValue": ".*",
            "current": {"text": "All", "value": "$__all"},
        }
    return var


def textbox(name, label, hide=0):
    return {
        "name": name,
        "label": label,
        "type": "textbox",
        "hide": hide,
        "query": "",
        "current": {"text": "", "value": ""},
    }


# `Ruido`: regex de las líneas a esconder (nunca vacía: `!~ ""` escondería todo).
NOISE = [
    # El `tool "X"` suelto duplica al `[tool] X {input}` que lo precede. `\x22` = `"` y `[[]` = `[`:
    # sobreviven igual con o sin el escape que Grafana le aplica a la variable.
    ("Sin duplicados de tools", "^tool (MCP )?\\x22[^\\x22]+\\x22$"),
    ("Todo", "^$"),
    ("Sin resultados de tools", "^(tool (MCP )?\\x22[^\\x22]+\\x22$|[[]tool:)"),
    ("Sin tools", "^([[]tool|tool )"),
]

dashboard = {
    "uid": "ia-issue",
    "title": "ia-flow · issue",
    "description": "Todo lo de un issue: qué ejecuciones tiene abiertas ahora, qué agentes corrieron y "
    "qué tools usaron, cada evento con su traza, los requests al modelo y los logs — con salto directo "
    "del log a su traza.",
    "tags": ["ia-flow", "otel"],
    "timezone": "browser",
    "schemaVersion": 39,
    "time": {"from": "now-24h", "to": "now"},
    "refresh": "30s",
    "links": [
        {
            "type": "dashboards",
            "tags": ["ia-flow"],
            "asDropdown": False,
            "title": "ia-flow",
            "keepTime": True,
        }
    ],
    "templating": {
        "list": [
            # Opciones desde Tempo (atributos de los spans, filtrados por el issue elegido). Un
            # click en las tablas pone cualquier valor, esté o no en la lista (una ejecución en
            # curso todavía no tiene span).
            tempo_values("issue", "Issue", "ia.issue"),
            tempo_values(
                "agent",
                "Agente",
                "ia.agent.id",
                '{ span.ia.issue =~ "${issue:pipe}" }',
                all_=True,
            ),
            # Texto, no lista: una ejecución en curso (o vieja) no está entre los valores de Tempo y
            # Grafana la resetearía a "Todos". La tabla "Ejecuciones del issue" es el selector, así
            # que la caja va oculta (hide=2): los clicks siguen poniendo `var-execution`.
            textbox("execution", "Ejecución", hide=2),
            textbox("search", "Buscar en los logs"),
            {
                "name": "noise",
                "label": "Ruido",
                "type": "custom",
                "query": ",".join(f"{k} : {v}" for k, v in NOISE),
                "options": [
                    {"text": k, "value": v, "selected": i == 0}
                    for i, (k, v) in enumerate(NOISE)
                ],
                "current": {"text": NOISE[0][0], "value": NOISE[0][1]},
            },
        ]
    },
    "panels": panels,
}

json.dump(dashboard, open(sys.argv[1], "w"), indent=2, ensure_ascii=False)
open(sys.argv[1], "a").write("\n")
print(f"{len(panels)} panels")
