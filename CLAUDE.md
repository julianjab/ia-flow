@AGENTS.md

## Claude Code en este repo

- El toolkit (subagentes, comandos, hooks, settings) está en [`.claude/README.md`](.claude/README.md).
- `architecture-guardian` antes de un commit que agrega carpetas o imports entre paquetes;
  `engine-agent-author` para agentes y pipelines del engine; `web-verifier` al tocar `apps/web`.
- **GitHub Actions corren en la Mac de Julián**, no en GitHub (2026-11-17, para no gastar los minutos del
  plan Free): los jobs leen `runs-on` de las variables del repo `RUNNER` y `RUNNER_MACOS`, las dos en
  `jab-mac` (la Mac directo: los tests fallan en Linux arm64, `z.strictObject` indefinido); vacías,
  vuelven al runner hospedado. Los runners son el paquete GhRunners (`apps/gh-runners` de mac-pulse; en
  cada Mac, `/Library/Application Support/GhRunners/runners.sh status`). `deploy-gateway` se queda en
  `ubuntu-latest` (imagen amd64). Si un run queda en cola, la Mac está abajo.
- Pedí confirmación antes de `gh pr merge`. Leer `.env*` y `rm -rf` están denegados.

## Paridad API ↔ web

Un cambio que agrega o modifica algo consumible por HTTP (endpoint, schema de `packages/shared`,
config de agente o proyecto) evalúa **explícitamente** si `apps/web` necesita verlo o editarlo. Si
aplica y entra en el alcance, se hace en el mismo cambio; si no entra, un issue (`/add-issue`); si
no aplica, se dice en el commit o el PR.

## Modularidad

- Contra la duplicación, la tercera vez: dos usos parecidos pueden divergir; al tercero se extrae.
- Interfaces angostas: un puerto declara lo que el consumidor necesita, no todo lo que el
  proveedor sabe hacer.
- Señales de tamaño (no dogma): archivo TS > 400 líneas, `.vue` > 300 o función > 50 → dividir
  antes de terminar el cambio.
- Efectos en los bordes: lógica en funciones puras; I/O (red, disco, `process.env`) detrás de un
  puerto inyectable.
