# ia-flow-cli

El pipeline de issues del [engine de ia-flow](../../README.md), sin servidor.

Declarás un roster en un `runner.yaml`, y cada run mueve el issue al estado
siguiente. No hay base de datos, ni proceso vivo, ni daemon: la fuente es `gh`,
el estado vive en las labels del issue, y el ejecutor es el CLI de Claude.

## El modelo, en cuatro frases

1. **El estado de un issue es una label**: `status:refine`, `status:build`. Una
   sola a la vez.
2. **Cada agente declara en qué estado corre** (y opcionalmente bajo qué
   condiciones). Dado un issue, el pipeline se pregunta *¿qué agente aplica
   acá?* y corre el primero que matchea.
3. **La salida del run es la transición.** Un run termina por `success`, por
   `error`, o por una salida con nombre que el agente pide — y esa salida dice a
   qué estado va el issue.
4. **Un run mueve un paso.** La cadena emerge de que el próximo run selecciona
   contra el estado nuevo; ningún agente conoce el pipeline entero.

## Instalación

```
/plugin marketplace add julianjab/ia-flow
/plugin install ia-flow-cli
```

Necesitás [`gh`](https://cli.github.com) autenticado (`gh auth login`) y `node`
o `bun` en el PATH. El plugin no tiene dependencias: no hay `npm install`.

## Configuración

Copiá [`runner.example.yaml`](./runner.example.yaml) a
`.claude/ia-flow/runner.yaml` en tu repo y editalo. También se busca en
`.flow/runner.yaml`, en `~/.claude/ia-flow/runner.yaml`, o donde apunte
`$IA_FLOW_CLI_CONFIG`.

Creá las labels que el roster usa (el plugin todavía no lo hace por vos):

```bash
gh label create ia-flow --description "Trackeado por el pipeline"
gh label create status:refine
gh label create status:build
```

## Uso

**Dentro de una sesión de Claude Code** — Claude hace el trabajo a la vista,
con tus permisos:

```
/ia-flow:run 42
```

**Desde la shell** — headless, lanzando `claude -p`:

```bash
node scripts/flow.mjs run 42
node scripts/flow.mjs run 42 --dry-run     # qué haría, sin escribir nada
node scripts/flow.mjs run 42 --agent builder
node scripts/flow.mjs apply 42 --exit success --summary "PRD listo"
```

Los dos caminos comparten la selección, el prompt, el comentario y la
transición. Lo único que cambia es quién ejecuta el trabajo.

## Cómo un agente elige su salida

El prompt de cada agente recibe `{{exits}}`, que le explica las salidas que
puede pedir y cómo. Para pedir una, cierra su último mensaje con:

```
<ia-flow:exit>
{ "exit": "needs-info", "summary": "Falta el repro" }
</ia-flow:exit>
```

Sin bloque, manda cómo terminó el run: bien ⇒ `success`, mal ⇒ `error`. Una
salida que el agente no declaró cae al default con un aviso — nunca se inventa
una transición.

## Variables del prompt

`{{task.number}}`, `{{task.title}}`, `{{task.body}}`, `{{task.status}}`,
`{{task.labels}}`, `{{task.author}}`, `{{task.url}}`, `{{task.comments}}`,
`{{repo.name}}`, `{{repo.owner}}`, `{{agent.id}}` y `{{exits}}`.

Una ruta que no existe **queda literal**: un typo se ve en el prompt en vez de
convertirse en un hueco silencioso.

## Qué NO hace todavía

Escanear el repo y elegir el próximo issue solo (`scan` / `next`), el loop
continuo, worktrees por tarea, y leer los comentarios de los PRs abiertos además
de los del issue. En esta versión le pasás el issue vos, y la conversación son
los comentarios del issue.

Un `comment: pr` o `pr-else-issue` cae al issue, con la misma regla que aplica
el engine cuando no hay PR abierto: perder el reporte de un run es peor que
dejarlo en el lugar menos específico.

## Estructura

| Archivo | Qué es |
| --- | --- |
| `scripts/core.mjs` | Todo lo que decide algo, **sin I/O**: el parser de YAML, el codec de labels, la selección, las transiciones, la salida del run, la validación de la config y el render del prompt. |
| `scripts/flow.mjs` | El borde: `gh`, el spawn del CLI, y el orden en que pasan las cosas. |
| `scripts/core.test.mjs` | Los tests, que corren sin red (`bun test plugins/ia-flow-cli`). |
