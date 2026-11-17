@AGENTS.md

## Claude Code en este repo

- El toolkit (subagentes, comandos, hooks, settings) está en [`.claude/README.md`](.claude/README.md).
- `architecture-guardian` antes de un commit que agrega carpetas o imports entre paquetes;
  `engine-agent-author` para agentes y pipelines del engine; `web-verifier` al tocar `apps/web`.
- **GitHub Actions, solo cuando Julián lo pide** (2026-11-17: el repo es privado y los minutos
  cuentan). Ningún workflow corre por push ni por PR: CI, Release Please, Release y Deploy gateway
  son `workflow_dispatch`. No lances `gh workflow run`, no mergees el Release PR ni pushees tags
  `v*` sin su pedido explícito en ese momento; el gate de cada push es lint + typecheck + test
  locales. Una release son dos corridas de `gh workflow run release-please.yml`: la primera abre o
  actualiza el Release PR; tras mergearlo, la segunda crea la tag y publica (`release.yml`).
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
