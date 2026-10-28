"""Genera apps/runner-v2/otel/grafana/dashboards/ia-flow-cost.json.

    python3 apps/runner-v2/otel/grafana/gen-cost-dashboard.py \\
      apps/runner-v2/otel/grafana/dashboards/ia-flow-cost.json

A diferencia de los otros tres, sólo usa Prometheus: las métricas `ia_flow_*` que el runner expone
en `GET /metrics` (`src/telemetry/metrics.ts`). Sirve para un Grafana sin Tempo ni Loki; el
datasource se elige con la variable `datasource` al importarlo.
"""

import json
import sys

DS = {"type": "prometheus", "uid": "${datasource}"}
F = 'project=~"$project", agent=~"$agent", pipeline=~"$pipeline", model=~"$model"'
P = 'project=~"$project", pipeline=~"$pipeline"'
COST = f"ia_flow_llm_cost_usd_total{{{F}}}"
TOKENS = f"ia_flow_llm_tokens_total{{{F}}}"
REQUESTS = f"ia_flow_llm_requests_total{{{F}}}"
RUNS = f"ia_flow_pipeline_runs_total{{{P}}}"
DURATION = f"ia_flow_pipeline_duration_seconds_bucket{{{P}}}"
AGENTS = f'ia_flow_agent_runs_total{{project=~"$project", agent=~"$agent", pipeline=~"$pipeline"}}'


def target(expr, legend=None, instant=False, fmt="time_series", ref="A"):
    t = {
        "refId": ref,
        "datasource": DS,
        "expr": expr,
        "instant": instant,
        "range": not instant,
        "format": fmt,
    }
    if legend:
        t["legendFormat"] = legend
    return t


def grid(x, y, w, h):
    return {"x": x, "y": y, "w": w, "h": h}


def stat(title, expr, pos, unit="short", decimals=None, description=""):
    defaults = {
        "unit": unit,
        "color": {"mode": "thresholds"},
        "thresholds": {"mode": "absolute", "steps": [{"color": "blue", "value": None}]},
    }
    if decimals is not None:
        defaults["decimals"] = decimals
    return {
        "type": "stat",
        "title": title,
        "description": description,
        "datasource": DS,
        "gridPos": pos,
        "targets": [target(expr, instant=True)],
        "fieldConfig": {"defaults": defaults, "overrides": []},
        "options": {
            "reduceOptions": {"calcs": ["lastNotNull"]},
            "colorMode": "background",
            "graphMode": "none",
            "textMode": "value",
        },
    }


def timeseries(
    title, targets, pos, unit="short", stack=True, bars=False, description=""
):
    return {
        "type": "timeseries",
        "title": title,
        "description": description,
        "datasource": DS,
        "gridPos": pos,
        "targets": targets,
        "fieldConfig": {
            "defaults": {
                "unit": unit,
                "custom": {
                    "drawStyle": "bars" if bars else "line",
                    "fillOpacity": 80 if bars else 20,
                    "stacking": {"mode": "normal" if stack else "none"},
                    "lineWidth": 1,
                },
            },
            "overrides": [],
        },
        "options": {
            "legend": {"displayMode": "table", "placement": "right", "calcs": ["sum"]},
            "tooltip": {"mode": "multi", "sort": "desc"},
        },
    }


def bars(title, expr, legend, pos, unit="currencyUSD", description=""):
    return {
        "type": "bargauge",
        "title": title,
        "description": description,
        "datasource": DS,
        "gridPos": pos,
        "targets": [target(expr, legend=legend, instant=True)],
        "fieldConfig": {
            "defaults": {
                "unit": unit,
                "decimals": 2,
                "color": {"mode": "continuous-BlYlRd"},
            },
            "overrides": [],
        },
        "options": {
            "orientation": "horizontal",
            "displayMode": "gradient",
            "reduceOptions": {"calcs": ["lastNotNull"]},
            "showUnfilled": True,
        },
    }


def variable(name, label, query, include_all=True):
    return {
        "name": name,
        "label": label,
        "type": "query",
        "datasource": DS,
        "query": {"query": query, "refId": name},
        "definition": query,
        "refresh": 2,
        "includeAll": include_all,
        "allValue": ".*",
        "multi": True,
        "current": {"text": "All", "value": "$__all"},
        "sort": 1,
    }


def inc(metric, by="", window="$__range"):
    group = f" by ({by})" if by else ""
    return f"sum{group} (increase({metric}[{window}]))"


panels = [
    stat(
        "Costo en el rango",
        inc(COST),
        grid(0, 0, 4, 4),
        unit="currencyUSD",
        decimals=2,
        description="Estimado a precio de lista (`pricing:` de runner.yaml). Incluye lo de suscripción: separalo con el panel «por facturación».",
    ),
    stat(
        "Costo pagado por token",
        inc(f'ia_flow_llm_cost_usd_total{{{F}, billing="api"}}'),
        grid(4, 0, 4, 4),
        unit="currencyUSD",
        decimals=2,
        description='Sólo `billing="api"`: lo que no sale de una suscripción.',
    ),
    stat("Requests al modelo", f"round({inc(REQUESTS)})", grid(8, 0, 4, 4)),
    stat("Tokens", inc(TOKENS), grid(12, 0, 4, 4), unit="short", decimals=1),
    stat(
        "Lectura de caché",
        f"{inc(f'ia_flow_llm_tokens_total{{{F}, type="cache_read"}}')} / {inc(TOKENS)}",
        grid(16, 0, 4, 4),
        unit="percentunit",
        decimals=1,
        description="Qué parte de los tokens se leyó de la caché: el grueso del costo en runs largos.",
    ),
    stat(
        "Ejecuciones corriendo",
        'sum(ia_flow_executions{state="running"})',
        grid(20, 0, 4, 4),
        description="Ahora. Pausadas y en cola: panel «Ejecuciones».",
    ),
    timeseries(
        "Costo por agente",
        [target(inc(COST, "agent", "$__interval"), legend="{{agent}}")],
        grid(0, 4, 12, 9),
        unit="currencyUSD",
        bars=True,
    ),
    timeseries(
        "Costo por modelo",
        [target(inc(COST, "model", "$__interval"), legend="{{model}}")],
        grid(12, 4, 12, 9),
        unit="currencyUSD",
        bars=True,
    ),
    bars(
        "Costo por pipeline",
        f"sort_desc({inc(COST, 'pipeline')})",
        "{{pipeline}}",
        grid(0, 13, 8, 10),
    ),
    bars(
        "Costo por repo",
        f"sort_desc({inc(COST, 'repo')})",
        "{{repo}}",
        grid(8, 13, 8, 10),
    ),
    bars(
        "Costo por facturación y origen",
        f"sort_desc({inc(COST, 'billing, origin')})",
        "{{billing}} · {{origin}}",
        grid(16, 13, 8, 10),
        description="`api`: se paga por token. `subscription`: sale de una suscripción (precio de lista, de referencia). `origin`: el runner o el host remoto.",
    ),
    timeseries(
        "Tokens por tipo",
        [target(inc(TOKENS, "type", "$__interval"), legend="{{type}}")],
        grid(0, 23, 12, 8),
        unit="short",
        bars=True,
    ),
    timeseries(
        "Costo por request, por agente",
        [
            target(
                f"{inc(COST, 'agent', '$__interval')} / {inc(REQUESTS, 'agent', '$__interval')}",
                legend="{{agent}}",
            )
        ],
        grid(12, 23, 12, 8),
        unit="currencyUSD",
        stack=False,
        description="Sube cuando crece el contexto de cada vuelta: la señal de un agente que lee de más.",
    ),
    timeseries(
        "Corridas de pipeline por estado",
        [
            target(
                f"round({inc(RUNS, 'pipeline, status', '$__interval')})",
                legend="{{pipeline}} · {{status}}",
            )
        ],
        grid(0, 31, 12, 8),
        bars=True,
    ),
    timeseries(
        "Duración p95 por pipeline",
        [
            target(
                f"histogram_quantile(0.95, sum by (pipeline, le) (increase({DURATION}[$__rate_interval])))",
                legend="{{pipeline}}",
            )
        ],
        grid(12, 31, 12, 8),
        unit="s",
        stack=False,
    ),
    timeseries(
        "Pasos de agente por provider",
        [
            target(
                f"round({inc(AGENTS, 'agent, provider', '$__interval')})",
                legend="{{agent}} · {{provider}}",
            )
        ],
        grid(0, 39, 12, 8),
        bars=True,
    ),
    timeseries(
        "Ejecuciones",
        [target("sum by (state) (ia_flow_executions)", legend="{{state}}")],
        grid(12, 39, 12, 8),
        stack=False,
    ),
    {
        "type": "table",
        "title": "Agente × pipeline × modelo",
        "datasource": DS,
        "gridPos": grid(0, 47, 24, 10),
        "targets": [
            target(
                inc(COST, "agent, pipeline, model"), instant=True, fmt="table", ref="A"
            ),
            target(
                f"round({inc(REQUESTS, 'agent, pipeline, model')})",
                instant=True,
                fmt="table",
                ref="B",
            ),
        ],
        "transformations": [
            {"id": "merge", "options": {}},
            {
                "id": "organize",
                "options": {
                    "excludeByName": {"Time": True},
                    "renameByName": {"Value #A": "Costo", "Value #B": "Requests"},
                },
            },
            {"id": "sortBy", "options": {"sort": [{"field": "Costo", "desc": True}]}},
        ],
        "fieldConfig": {
            "defaults": {},
            "overrides": [
                {
                    "matcher": {"id": "byName", "options": "Costo"},
                    "properties": [
                        {"id": "unit", "value": "currencyUSD"},
                        {"id": "decimals", "value": 2},
                    ],
                }
            ],
        },
        "options": {"showHeader": True},
    },
]

dashboard = {
    "uid": "ia-flow-cost",
    "title": "ia-flow · costo y actividad",
    "description": "Costo estimado, tokens y corridas del runner de ia-flow, desde las métricas ia_flow_* de GET /metrics.",
    "tags": ["ia-flow", "llm", "cost"],
    "timezone": "browser",
    "schemaVersion": 39,
    "editable": True,
    "refresh": "1m",
    "time": {"from": "now-24h", "to": "now"},
    "templating": {
        "list": [
            {
                "name": "datasource",
                "label": "Prometheus",
                "type": "datasource",
                "query": "prometheus",
                "current": {},
                "refresh": 1,
            },
            variable(
                "project",
                "Proyecto",
                "label_values(ia_flow_llm_requests_total, project)",
            ),
            variable(
                "agent",
                "Agente",
                'label_values(ia_flow_llm_requests_total{project=~"$project"}, agent)',
            ),
            variable(
                "pipeline",
                "Pipeline",
                'label_values(ia_flow_llm_requests_total{project=~"$project"}, pipeline)',
            ),
            variable(
                "model",
                "Modelo",
                'label_values(ia_flow_llm_requests_total{project=~"$project"}, model)',
            ),
        ]
    },
    "panels": [{**panel, "id": index + 1} for index, panel in enumerate(panels)],
}

json.dump(dashboard, open(sys.argv[1], "w"), indent=2, ensure_ascii=False)
open(sys.argv[1], "a").write("\n")
