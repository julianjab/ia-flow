---
description: Valida la config de ia-flow del repo actual (carga runner.yaml + projects/ con el runner)
argument-hint: "[runner.yaml | carpeta]"
---

Corré `${CLAUDE_PLUGIN_ROOT}/scripts/validate-config.sh $ARGUMENTS` (si no hay argumento, el script
busca el `runner.yaml` del cwd). Reportá la salida real; si hay errores de schema, citá archivo y
campo y proponé el arreglo (leé `ia-flow-agent-authoring` si hace falta). No edites sin que lo pidan.
