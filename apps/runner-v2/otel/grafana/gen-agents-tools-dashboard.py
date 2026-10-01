"""Genera apps/runner-v2/otel/grafana/dashboards/ia-agents-tools.json.

    python3 apps/runner-v2/otel/grafana/gen-agents-tools-dashboard.py \\
      apps/runner-v2/otel/grafana/dashboards/ia-agents-tools.json
"""

import json
import sys

PROM = {"type": "prometheus", "uid": "prometheus"}
TEMPO = {"type": "tempo", "uid": "tempo"}
LOKI = {"type": "loki", "uid": "loki"}
S = 'service=~"$service"'


def calls(name_re, extra=""):
    return f'traces_spanmetrics_calls_total{{{S}, span_name=~"{name_re}"{extra}}}'


def latency(name_re):
    return f'traces_spanmetrics_latency_bucket{{{S}, span_name=~"{name_re}"}}'


ERR = ', status_code="STATUS_CODE_ERROR"'


def by(label, prefix, expr):
    """Agrupa por el nombre sin prefijo (`agent refiner` → agent=refiner)."""
    return f'sum by ({label}) (label_replace({expr}, "{label}", "$1", "span_name", "{prefix} (.*)"))'


def quantile(q, label, prefix, name_re):
    inner = f'label_replace(increase({latency(name_re)}[$__range]), "{label}", "$1", "span_name", "{prefix} (.*)")'
    return f"histogram_quantile({q}, sum by ({label}, le) ({inner}))"


def prom(ref, expr, fmt="time_series", instant=False, legend=None):
    t = {
        "refId": ref,
        "datasource": PROM,
        "expr": expr,
        "format": fmt,
        "instant": instant,
        "range": not instant,
    }
    if legend:
        t["legendFormat"] = legend
    return t


def tempo(ref, query, instant=True):
    return {
        "refId": ref,
        "datasource": TEMPO,
        "queryType": "traceql",
        "query": query,
        "metricsQueryType": "instant" if instant else "range",
        "limit": 20,
        "tableType": "traces",
    }


panels = []
next_id = 1


def add(panel, x, y, w, h):
    global next_id
    panel["id"] = next_id
    next_id += 1
    panel["gridPos"] = {"x": x, "y": y, "w": w, "h": h}
    panels.append(panel)


def row(title, y):
    add({"type": "row", "title": title, "collapsed": False, "panels": []}, 0, y, 24, 1)


def stat(title, expr, unit="short", description="", thresholds=None, decimals=None):
    p = {
        "type": "stat",
        "title": title,
        "description": description,
        "datasource": PROM,
        "targets": [prom("A", expr, instant=True)],
        "fieldConfig": {
            "defaults": {
                "unit": unit,
                "color": {"mode": "thresholds"},
                "thresholds": thresholds
                or {"mode": "absolute", "steps": [{"color": "blue", "value": None}]},
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
    if decimals is not None:
        p["fieldConfig"]["defaults"]["decimals"] = decimals
    return p


ERROR_STEPS = {
    "mode": "absolute",
    "steps": [
        {"color": "green", "value": None},
        {"color": "orange", "value": 0.05},
        {"color": "red", "value": 0.2},
    ],
}


def ratio(name_re):
    return (
        f"(sum(increase({calls(name_re, ERR)}[$__range])) or vector(0))"
        f" / sum(increase({calls(name_re)}[$__range]))"
    )


def prom_table(title, description, label, prefix, name_re, header, count="Corridas"):
    """Una fila por agente / tool / modelo: corridas, errores, % error, p50, p95."""
    targets = [
        prom(
            "A",
            f"round({by(label, prefix, f'increase({calls(name_re)}[$__range])')})",
            "table",
            True,
        ),
        prom(
            "B",
            f"round({by(label, prefix, f'increase({calls(name_re, ERR)}[$__range])')})",
            "table",
            True,
        ),
        prom(
            "C",
            f"round({by(label, prefix, f'increase({calls(name_re, ERR)}[$__range])')})"
            f" / round({by(label, prefix, f'increase({calls(name_re)}[$__range])')})",
            "table",
            True,
        ),
        prom("D", quantile(0.5, label, prefix, name_re), "table", True),
        prom("E", quantile(0.95, label, prefix, name_re), "table", True),
    ]
    return {
        "type": "table",
        "title": title,
        "description": description,
        "datasource": PROM,
        "targets": targets,
        "transformations": [
            {"id": "merge", "options": {}},
            {
                "id": "organize",
                "options": {
                    "excludeByName": {"Time": True},
                    "indexByName": {
                        label: 0,
                        "Value #A": 1,
                        "Value #B": 2,
                        "Value #C": 3,
                        "Value #D": 4,
                        "Value #E": 5,
                    },
                    "renameByName": {
                        label: header,
                        "Value #A": count,
                        "Value #B": "Errores",
                        "Value #C": "% error",
                        "Value #D": "p50",
                        "Value #E": "p95",
                    },
                },
            },
            {
                "id": "sortBy",
                "options": {"sort": [{"field": count, "desc": True}]},
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
            },
            "overrides": [
                {
                    "matcher": {"id": "byName", "options": "% error"},
                    "properties": [
                        {"id": "unit", "value": "percentunit"},
                        {"id": "decimals", "value": 1},
                        {"id": "thresholds", "value": ERROR_STEPS},
                        {"id": "custom.cellOptions", "value": {"type": "color-text"}},
                    ],
                },
                {
                    "matcher": {"id": "byName", "options": "Errores"},
                    "properties": [{"id": "noValue", "value": "0"}],
                },
                {
                    "matcher": {"id": "byRegexp", "options": "^p(50|95)$"},
                    "properties": [
                        {"id": "unit", "value": "s"},
                        {"id": "decimals", "value": 1},
                    ],
                },
                {
                    "matcher": {"id": "byName", "options": header},
                    "properties": [{"id": "custom.width", "value": 190}],
                },
                {
                    "matcher": {"id": "byName", "options": count},
                    "properties": [
                        {
                            "id": "custom.cellOptions",
                            "value": {
                                "type": "gauge",
                                "mode": "basic",
                                "valueDisplayMode": "text",
                            },
                        },
                        {"id": "color", "value": {"mode": "continuous-BlPu"}},
                        {"id": "custom.width", "value": 150},
                    ],
                },
            ],
        },
        "options": {"showHeader": True, "cellHeight": "sm", "footer": {"show": False}},
    }


def timeseries(title, description, targets, unit="short", stacked=True, bars=True):
    # Barras de conteo: `increase(...[$__interval])` con intervalo mínimo — ventanas que no se
    # pisan, así la suma de la leyenda da el total del rango ($__rate_interval contaría doble).
    return {
        "type": "timeseries",
        "title": title,
        "description": description,
        "datasource": PROM,
        "interval": "10m" if bars else None,
        "targets": targets,
        "fieldConfig": {
            "defaults": {
                "unit": unit,
                "decimals": 0 if bars else None,
                "custom": {
                    "drawStyle": "bars" if bars else "line",
                    "fillOpacity": 80 if bars else 10,
                    "lineWidth": 1,
                    "stacking": {"mode": "normal" if stacked else "none", "group": "A"},
                    "showPoints": "never",
                },
            },
            "overrides": [],
        },
        "options": {
            "legend": {
                "displayMode": "table",
                "placement": "right",
                # Conteos: el total del rango. Latencias: sumarlas no significa nada.
                "calcs": ["sum"] if bars else ["max", "mean"],
                "sortBy": "Total" if bars else "Max",
                "sortDesc": True,
            },
            "tooltip": {"mode": "multi", "sort": "desc"},
        },
    }


UNQUOTE = {
    "type": "regex",
    "options": {"pattern": '^"(.*)"$', "result": {"text": "$1"}},
}


def tempo_table(
    title, description, query, transformations, gauge_field, extra_overrides=()
):
    """Tabla de TraceQL metrics (instant), UNA query por panel.

    Tempo pone como `refId` de cada frame el string de labels de la serie, no la letra de la
    query: una transformación filtrada por query no matchea nada, y dos queries con la misma
    agrupación no se pueden juntar en columnas. Lo que haya que pivotear va en la agrupación de
    la query (ej. `by (…, status)`) + `joinByLabels`.
    """
    return {
        "type": "table",
        "title": title,
        "description": description,
        "datasource": TEMPO,
        "timeFrom": "24h",
        "targets": [tempo("A", query)],
        "transformations": transformations,
        "fieldConfig": {
            "defaults": {
                "custom": {
                    "align": "auto",
                    "cellOptions": {"type": "auto"},
                    "minWidth": 60,
                },
                "mappings": [UNQUOTE],
                "unit": "locale",
                "decimals": 0,
                "noValue": "0",
            },
            "overrides": [
                {
                    "matcher": {"id": "byName", "options": "span.ia.agent.id"},
                    "properties": [{"id": "displayName", "value": "Agente"}],
                },
                {
                    "matcher": {"id": "byName", "options": "span.gen_ai.tool.name"},
                    "properties": [{"id": "displayName", "value": "Tool"}],
                },
                {
                    "matcher": {"id": "byName", "options": "span.gen_ai.request.model"},
                    "properties": [{"id": "displayName", "value": "Modelo"}],
                },
                {
                    "matcher": {"id": "byName", "options": gauge_field},
                    "properties": [
                        {
                            "id": "custom.cellOptions",
                            "value": {
                                "type": "gauge",
                                "mode": "basic",
                                "valueDisplayMode": "text",
                            },
                        },
                        {"id": "color", "value": {"mode": "continuous-BlPu"}},
                        {"id": "custom.width", "value": 170},
                    ],
                },
                *extra_overrides,
            ],
        },
        "options": {"showHeader": True, "cellHeight": "sm", "footer": {"show": False}},
    }


def tempo_sum_table(title, description, attribute, value_name):
    """Suma de un atributo numérico de los spans `chat`, por agente y modelo."""
    query = (
        f'{{ span.gen_ai.operation.name = "chat" && {SVC} && {AGENT} }}'
        f" | sum_over_time({attribute}) by (span.ia.agent.id, span.gen_ai.request.model)"
    )
    return tempo_table(
        title,
        description,
        query,
        [
            {"id": "labelsToFields", "options": {"mode": "columns"}},
            {"id": "merge", "options": {}},
            {
                "id": "organize",
                "options": {
                    "excludeByName": {"time": True, "Time": True},
                    "indexByName": {
                        "span.ia.agent.id": 0,
                        "span.gen_ai.request.model": 1,
                        "value": 2,
                    },
                    "renameByName": {"value": value_name},
                },
            },
            {
                "id": "sortBy",
                "options": {"sort": [{"field": value_name, "desc": True}]},
            },
        ],
        value_name,
    )


SVC = 'resource.service.name =~ "$service"'
AGENT = 'span.ia.agent.id =~ "$agent"'

# ── Resumen ────────────────────────────────────────────────────────────────────────
row("Resumen", 0)
add(
    stat(
        "Corridas de agentes",
        f"round(sum(increase({calls('agent .*')}[$__range])))",
        description="Pasos de agente (span `agent <id>`) en el rango.",
    ),
    0,
    1,
    4,
    4,
)
add(
    stat(
        "Agentes con error",
        ratio("agent .*"),
        "percentunit",
        "Corridas de agente que terminaron en ERROR (incluidas las que cubrió un onError).",
        ERROR_STEPS,
        1,
    ),
    4,
    1,
    4,
    4,
)
add(
    stat(
        "Duración p95 de un agente",
        f"histogram_quantile(0.95, sum by (le) (increase({latency('agent .*')}[$__range])))",
        "s",
        "Del arranque del agente hasta que eligió salida (incluye sus requests y tools).",
        decimals=1,
    ),
    8,
    1,
    4,
    4,
)
add(
    stat(
        "Llamadas a tools",
        f"round(sum(increase({calls('execute_tool .*')}[$__range])))",
        description="Tools locales ejecutadas (span `execute_tool <name>`), incluidas las `submit_*`.",
    ),
    12,
    1,
    4,
    4,
)
add(
    stat(
        "Tools con error",
        ratio("execute_tool .*"),
        "percentunit",
        "Llamadas a tools que devolvieron error al modelo (is_error).",
        ERROR_STEPS,
        1,
    ),
    16,
    1,
    4,
    4,
)
add(
    stat(
        "Requests al modelo",
        f"round(sum(increase({calls('chat .*')}[$__range])))",
        description="Requests a la Messages API (span `chat <model>`).",
    ),
    20,
    1,
    4,
    4,
)

# ── Agentes ────────────────────────────────────────────────────────────────────────
row("Agentes", 5)
add(
    prom_table(
        "Por agente",
        "Corridas, errores y duración de cada agente en el rango.",
        "agent",
        "agent",
        "agent .*",
        "Agente",
    ),
    0,
    6,
    12,
    10,
)
add(
    timeseries(
        "Corridas por agente",
        "Corridas de cada agente en el tiempo.",
        [
            prom(
                "A",
                by("agent", "agent", f"increase({calls('agent .*')}[$__interval])"),
                legend="{{agent}}",
            )
        ],
    ),
    12,
    6,
    12,
    10,
)

# ── Tools ──────────────────────────────────────────────────────────────────────────
row("Tools", 16)
add(
    prom_table(
        "Por tool",
        "Llamadas, errores y duración de cada tool en el rango. Las `submit_*` y "
        "`fail_turn` son las tools con las que un agente elige su salida.",
        "tool",
        "execute_tool",
        "execute_tool .*",
        "Tool",
        "Llamadas",
    ),
    0,
    17,
    12,
    12,
)
add(
    timeseries(
        "Llamadas por tool",
        "Llamadas a cada tool en el tiempo.",
        [
            prom(
                "A",
                by(
                    "tool",
                    "execute_tool",
                    f"increase({calls('execute_tool .*')}[$__interval])",
                ),
                legend="{{tool}}",
            )
        ],
    ),
    12,
    17,
    12,
    12,
)

# ── Modelos ────────────────────────────────────────────────────────────────────────
row("Modelos", 29)
add(
    prom_table(
        "Por modelo",
        "Requests a la API por modelo; la duración es la de cada request.",
        "model",
        "chat",
        "chat .*",
        "Modelo",
        "Requests",
    ),
    0,
    30,
    12,
    8,
)
add(
    timeseries(
        "Duración p95 por modelo",
        "Latencia p95 de cada request a la API.",
        [
            prom(
                "A",
                "histogram_quantile(0.95, sum by (model, le) (label_replace(increase("
                f'{latency("chat .*")}[$__rate_interval]), "model", "$1", "span_name", "chat (.*)")))',
                legend="{{model}}",
            )
        ],
        unit="s",
        stacked=False,
        bars=False,
    ),
    12,
    30,
    12,
    8,
)

# ── Tempo: tools por agente y tokens ───────────────────────────────────────────────
TRACES_NOTE = "Sale de las trazas (TraceQL metrics): cubre las últimas 24 h aunque el rango del dashboard sea otro."
row("Por agente, desde las trazas (últimas 24 h — tope de TraceQL metrics)", 38)
add(
    tempo_table(
        "Tools que usa cada agente",
        "Llamadas a cada tool por agente, y cuántas devolvieron error al modelo. "
        + TRACES_NOTE,
        f'{{ name =~ "execute_tool .*" && {SVC} && {AGENT} }}'
        " | count_over_time() by (span.ia.agent.id, span.gen_ai.tool.name, status)",
        [
            # Una serie por (agente, tool, status) → una fila por (agente, tool), una columna por status.
            {
                "id": "joinByLabels",
                "options": {
                    "value": "status",
                    "join": ["span.ia.agent.id", "span.gen_ai.tool.name"],
                },
            },
            {
                "id": "calculateField",
                "options": {
                    "mode": "reduceRow",
                    "reduce": {
                        "include": ['"unset"', '"error"', '"ok"'],
                        "reducer": "sum",
                    },
                    "alias": "Llamadas",
                },
            },
            {
                "id": "organize",
                "options": {
                    "excludeByName": {'"unset"': True, '"ok"': True},
                    "indexByName": {
                        "span.ia.agent.id": 0,
                        "span.gen_ai.tool.name": 1,
                        "Llamadas": 2,
                        '"error"': 3,
                    },
                    "renameByName": {'"error"': "Errores"},
                },
            },
            {
                "id": "sortBy",
                "options": {"sort": [{"field": "Llamadas", "desc": True}]},
            },
        ],
        "Llamadas",
    ),
    0,
    39,
    12,
    12,
)
add(
    tempo_table(
        "Requests al modelo por agente",
        "Cuántas requests hizo cada agente a cada modelo. " + TRACES_NOTE,
        f'{{ span.gen_ai.operation.name = "chat" && {SVC} && {AGENT} }}'
        " | count_over_time() by (span.ia.agent.id, span.gen_ai.request.model)",
        [
            {"id": "labelsToFields", "options": {"mode": "columns"}},
            {"id": "merge", "options": {}},
            {
                "id": "organize",
                "options": {
                    "excludeByName": {"time": True, "Time": True},
                    "indexByName": {
                        "span.ia.agent.id": 0,
                        "span.gen_ai.request.model": 1,
                        "value": 2,
                    },
                    "renameByName": {"value": "Requests"},
                },
            },
            {
                "id": "sortBy",
                "options": {"sort": [{"field": "Requests", "desc": True}]},
            },
        ],
        "Requests",
    ),
    12,
    39,
    12,
    12,
)
add(
    tempo_sum_table(
        "Tokens de entrada",
        "Tokens de entrada (sin contar los leídos de cache) de todas las requests. "
        + TRACES_NOTE,
        "span.gen_ai.usage.input_tokens",
        "Entrada",
    ),
    0,
    51,
    8,
    10,
)
add(
    tempo_sum_table(
        "Tokens de salida",
        "Tokens generados por el modelo. " + TRACES_NOTE,
        "span.gen_ai.usage.output_tokens",
        "Salida",
    ),
    8,
    51,
    8,
    10,
)
add(
    tempo_sum_table(
        "Tokens leídos de cache",
        "Tokens del prompt cache: cuanto más altos respecto de la entrada, más barato sale el "
        "agente. " + TRACES_NOTE,
        "span.gen_ai.usage.cache_read_input_tokens",
        "Cache",
    ),
    16,
    51,
    8,
    10,
)

# ── Bash: qué comandos corren los agentes ───────────────────────────────────────────
# El span de `bash_run` sólo trae el input crudo (`{"command":"git status"}`) y TraceQL no extrae
# partes de un atributo; el log `tool "bash_run"` lleva el mismo input como structured metadata
# (`ia_tool_input`) y LogQL sí lo puede cortar con una regex.
BASH_LOGS = (
    # `.+` además del filtro: con "All" el `$service` vale `.*`, y Loki rechaza un selector que
    # matchea vacío.
    '{service_name=~".+", service_name=~"$service"} |= "bash_run" | gen_ai_tool_name = "bash_run"'
    ' | ia_tool_input != "" | ia_agent_id =~ "$agent"'
    ' | line_format "{{.ia_tool_input}}"'
)
PROGRAM = BASH_LOGS + r' | regexp "\"command\":\"(?P<program>[^ \"]+)" | program != ""'
# `(?:[^"\\]|\\.)*`: un `\"` dentro del comando (`git commit -m \"…\"`) no lo corta.
COMMAND = (
    BASH_LOGS
    + r' | regexp "\"command\":\"(?P<command>(?:[^\"\\\\]|\\\\.)*)\"" | command != ""'
)


def loki(ref, expr, instant=True, legend=None):
    t = {
        "refId": ref,
        "datasource": LOKI,
        "expr": expr,
        "queryType": "instant" if instant else "range",
    }
    if legend:
        t["legendFormat"] = legend
    return t


def loki_table(title, description, expr, columns, value_name, gauge=True, widths=None):
    """Tabla de un conteo de Loki (instant, una serie por combinación de labels)."""
    overrides = [
        {
            "matcher": {"id": "byName", "options": col},
            "properties": [{"id": "displayName", "value": name}],
        }
        for col, name in columns.items()
    ]
    if gauge:
        overrides.append(
            {
                "matcher": {"id": "byName", "options": value_name},
                "properties": [
                    {
                        "id": "custom.cellOptions",
                        "value": {
                            "type": "gauge",
                            "mode": "basic",
                            "valueDisplayMode": "text",
                        },
                    },
                    {"id": "color", "value": {"mode": "continuous-BlPu"}},
                    {"id": "custom.width", "value": 170},
                ],
            }
        )
    for col, width in (widths or {}).items():
        overrides.append(
            {
                "matcher": {"id": "byName", "options": col},
                "properties": [{"id": "custom.width", "value": width}],
            }
        )
    return {
        "type": "table",
        "title": title,
        "description": description,
        "datasource": LOKI,
        "targets": [loki("A", expr)],
        "transformations": [
            {"id": "labelsToFields", "options": {"mode": "columns"}},
            {"id": "merge", "options": {}},
            {
                "id": "organize",
                "options": {
                    "excludeByName": {"Time": True},
                    # Loki nombra la columna `Value #<refId>`.
                    "indexByName": {
                        **{col: i for i, col in enumerate(columns)},
                        "Value #A": len(columns),
                    },
                    "renameByName": {"Value #A": value_name},
                },
            },
            {
                "id": "sortBy",
                "options": {"sort": [{"field": value_name, "desc": True}]},
            },
        ],
        "fieldConfig": {
            "defaults": {
                "custom": {
                    "align": "auto",
                    "cellOptions": {"type": "auto"},
                    "minWidth": 60,
                },
                "unit": "locale",
                "decimals": 0,
            },
            "overrides": overrides,
        },
        "options": {"showHeader": True, "cellHeight": "sm", "footer": {"show": False}},
    }


row("Bash — qué comandos corren los agentes (bash_run)", 61)
add(
    loki_table(
        "Programas más usados",
        "Cuántas veces corrió cada programa (el primer token del comando: git, uv, sed…). Sale de "
        'los logs `tool "bash_run"` del rango.',
        f"sum by (program) (count_over_time({PROGRAM} [$__range]))",
        {"program": "Programa"},
        "Veces",
    ),
    0,
    62,
    6,
    11,
)
add(
    loki_table(
        "Comandos más usados",
        "Los comandos completos, con sus argumentos, que más se repiten en el rango.",
        f"topk(25, sum by (command) (count_over_time({COMMAND} [$__range])))",
        {"command": "Comando"},
        "Veces",
    ),
    6,
    62,
    10,
    11,
)
add(
    loki_table(
        "Programas por agente",
        "Qué programas usa cada agente, y cuántas veces.",
        f"sum by (ia_agent_id, program) (count_over_time({PROGRAM} [$__range]))",
        {"ia_agent_id": "Agente", "program": "Programa"},
        "Veces",
    ),
    16,
    62,
    8,
    11,
)
add(
    {
        "type": "timeseries",
        "title": "Programas en el tiempo",
        "description": "Ejecuciones de cada programa en el tiempo.",
        "datasource": LOKI,
        "interval": "10m",
        "targets": [
            loki(
                "A",
                f"sum by (program) (count_over_time({PROGRAM} [$__interval]))",
                instant=False,
                legend="{{program}}",
            )
        ],
        "fieldConfig": {
            "defaults": {
                "unit": "short",
                "decimals": 0,
                "custom": {
                    "drawStyle": "bars",
                    "fillOpacity": 80,
                    "lineWidth": 1,
                    "stacking": {"mode": "normal", "group": "A"},
                    "showPoints": "never",
                },
            },
            "overrides": [],
        },
        "options": {
            "legend": {
                "displayMode": "table",
                "placement": "right",
                "calcs": ["sum"],
                "sortBy": "Total",
                "sortDesc": True,
            },
            "tooltip": {"mode": "multi", "sort": "desc"},
        },
    },
    0,
    73,
    14,
    10,
)
add(
    tempo_table(
        "Comandos que fallaron",
        "Comandos de `bash_run` que devolvieron error al modelo (exit ≠ 0, comando no permitido por "
        "la política, binario inexistente…). " + TRACES_NOTE,
        f'{{ name = "execute_tool bash_run" && status = error && {SVC} && {AGENT} }}'
        " | count_over_time() by (span.ia.agent.id, span.ia.tool.input)",
        [
            {"id": "labelsToFields", "options": {"mode": "columns"}},
            {"id": "merge", "options": {}},
            {
                "id": "organize",
                "options": {
                    "excludeByName": {"time": True, "Time": True},
                    "indexByName": {
                        "span.ia.agent.id": 0,
                        "span.ia.tool.input": 1,
                        "value": 2,
                    },
                    "renameByName": {"value": "Fallos"},
                },
            },
            {"id": "sortBy", "options": {"sort": [{"field": "Fallos", "desc": True}]}},
        ],
        "Fallos",
        [
            {
                "matcher": {"id": "byName", "options": "span.ia.tool.input"},
                "properties": [
                    {"id": "displayName", "value": "Comando"},
                    # El input llega como JSON: `{"command":"git status"}` → `git status`.
                    {
                        "id": "mappings",
                        "value": [
                            {
                                "type": "regex",
                                "options": {
                                    "pattern": '^"?\\{\\\\?"command\\\\?":\\\\?"(.*?)\\\\?"[,}].*$',
                                    "result": {"text": "$1"},
                                },
                            }
                        ],
                    },
                ],
            },
            {
                "matcher": {"id": "byName", "options": "span.ia.agent.id"},
                "properties": [{"id": "custom.width", "value": 170}],
            },
        ],
    ),
    14,
    73,
    10,
    10,
)

dashboard = {
    "uid": "ia-agents-tools",
    "title": "ia-flow · agentes y tools",
    "description": "Métricas por agente, tool y modelo: corridas, errores, duración, qué tools usa "
    "cada agente y cuántos tokens gasta. Prometheus (span metrics de Tempo) para "
    "cualquier rango; Tempo (TraceQL metrics) para el cruce agente × tool y los tokens.",
    "tags": ["ia-flow", "otel"],
    "timezone": "browser",
    "schemaVersion": 39,
    "time": {"from": "now-24h", "to": "now"},
    "refresh": "1m",
    "links": [
        {
            "type": "dashboards",
            "tags": ["ia-flow"],
            "asDropdown": False,
            "title": "ia-flow",
            "includeVars": False,
            "keepTime": True,
        }
    ],
    "templating": {
        "list": [
            {
                "name": "service",
                "label": "Servicio",
                "type": "query",
                "datasource": PROM,
                "query": {
                    "query": 'label_values(traces_spanmetrics_calls_total{span_name=~"agent .*"}, service)',
                    "refId": "service",
                },
                "definition": 'label_values(traces_spanmetrics_calls_total{span_name=~"agent .*"}, service)',
                "refresh": 2,
                "includeAll": True,
                "allValue": ".*",
                "multi": True,
                "current": {"text": "All", "value": "$__all"},
            },
            {
                "name": "agent",
                "label": "Agente (regex; trazas y bash)",
                "type": "textbox",
                "query": ".*",
                "current": {"text": ".*", "value": ".*"},
            },
        ]
    },
    "panels": panels,
}


def prune(o):
    if isinstance(o, dict):
        return {k: prune(v) for k, v in o.items() if v is not None}
    if isinstance(o, list):
        return [prune(v) for v in o]
    return o


json.dump(prune(dashboard), open(sys.argv[1], "w"), indent=2, ensure_ascii=False)
open(sys.argv[1], "a").write("\n")
print(f"{len(panels)} panels")
