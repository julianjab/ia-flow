# @ia-flow/slack — Slack, entero y opcional

Todo lo que ia-flow sabe de Slack vive acá: el cliente Web API, las tools que
ve un agente, el directorio del workspace, el pedido de review y el borde de la
Events API. Antes estaba repartido entre `packages/tools/src/slack/`,
`apps/server/src/adapters/slack/` y `apps/server/src/application/use-cases/`,
y esa dispersión era el problema: **no había forma de sacar Slack** sin
recorrer tres capas de dos paquetes distintos preguntándose qué más se rompía.

## Plug-and-play, en dos niveles

**En build.** Sacar Slack de un deploy es sacar `installSlack(...)` del
composition root y la dependencia del `package.json`. El paquete no importa
`apps/server` (ni al revés en ningún módulo interno): la única superficie es
`src/index.ts`.

**En runtime.** `SLACK_BOT_TOKEN` es el interruptor. No hay un
`IA_FLOW_SLACK_ENABLED` aparte a propósito: un flag que puede contradecir a la
credencial (prendido sin token, apagado con token) inventa un estado inválido
que después alguien tiene que diagnosticar, y la credencial ya contesta la
pregunta — sin token no hay nada que este paquete pueda hacer.

Son dos interruptores porque son dos capacidades independientes: `SLACK_BOT_TOKEN`
habilita hablar (tools, directorio, review) y `SLACK_SIGNING_SECRET` habilita
escuchar (`POST /api/webhooks/slack`). Se puede pedir review sin recibir
mensajes, que es el caso normal.

Apagado, cada pieza se apaga a su manera y **ninguna explota**:

| Pieza | Sin credencial |
| --- | --- |
| Las 5 tools (`slack_*`, `request_slack_review`) | no se registran: no aparecen en `GET /api/tools` ni en el editor de agentes |
| `SlackDirectory` | devuelve listas vacías con el motivo en `warnings` |
| `/api/slack/*` | 503 con el motivo |
| `POST /api/webhooks/slack` | 503 (ya era así: falla *closed*) |
| La UI | oculta los campos de review — lo lee de `GET /api/integrations` |

**Se lee por uso, nunca se captura.** El operador pega el token en
Configuración y eso escribe SQLite; `envRepo.loadIntoProcess()` lo vuelca a
`Bun.env` DESPUÉS de que el composition root se evaluó. Un booleano calculado
al importar dejaría Slack apagado hasta reiniciar. Por eso `enabled` es un
getter y existe `sync()`, que la ruta de env-vars llama cuando alguien toca una
variable de Slack — la misma forma que `githubCredentials.reset()`.

## Por qué el registro de tools NO es un efecto de importar

En `@ia-flow/tools` importar el índice registra todo. Acá no: es
`registerSlackTools()`. La diferencia la ve el operador — el editor de agentes
lista lo que devuelve `GET /api/tools`, y una `slack_post_message` ofrecida por
un proceso sin credencial es una tool que se puede tildar y siempre falla.

## Qué NO se llevó, y por qué

- **`SlackMemberRef`, `slackReviewChannel`, `buildSlackReviewMessage`** siguen
  en `@ia-flow/shared`. Cruzan la frontera server↔web (los valida `.parse()` en
  la web), y esa frontera es lo que `shared` ES. Un tipo de red en otro paquete
  obligaría a `apps/web` a depender de un paquete de servidor.
- **`slack.message` en `event-catalog.ts`** sigue en `shared` por lo mismo: es
  el catálogo que dibuja el editor de reglas.
- **Las rutas Hono** siguen en `apps/server/src/routes/`. HTTP es de la app;
  lo que el paquete aporta es lo que hay que SABER de Slack para servirlas
  (`verifySlackSignature`, `urlVerification`), que es justo lo que nadie
  debería re-derivar.

## Dependencias

`shared` (contratos), `tools` (el registry donde se registran las tools),
`issue-sources` (el `ProjectSource` del pedido de review) y `agent-engine`
(el tipo `IRepoRepository`). La flecha va en un solo sentido: **`tools` ya no
importa nada de Slack** — invertirla era la condición para que Slack se pudiera
sacar sin tocar el resto de las tools.
