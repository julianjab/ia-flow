# @ia-flow/slack-socket

Slack por **Socket Mode**: el runner abre una conexión WebSocket hacia Slack con un app token, así
que no necesita una URL pública ni verificar firmas. Standalone (no importa nada del monorepo),
sin SDK; `fetch` y `WebSocket` son inyectables, así que sus tests no tocan la red.

## Uso

```ts
import { SlackSocketClient, stripMention } from '@ia-flow/slack-socket'

const socket = new SlackSocketClient({
  appToken: () => process.env.SLACK_APP_TOKEN, // `xapp-…`, scope `connections:write`
  botUserId: 'U0BOT', // sus propios mensajes se descartan
  onEvent: async (event) => {
    // event.kind: 'app_mention' | 'message'
    // event.user / channel / ts / threadTs / isThreadReply / mentions
    console.log(stripMention(event.text, 'U0BOT'))
  },
  log: console.log,
})
if (socket.enabled) await socket.start() // resuelve con el `hello` de Slack
// …
socket.stop()
```

## Qué garantiza

- **Ack inmediato** de cada envelope (Slack reintenta lo que no se confirma en 3 s).
- **Una entrega por mensaje**: Slack manda `app_mention` Y `message` para la misma mención, y repite
  el evento si reintenta — se deduplica por `event_id` y por `canal:ts`.
- **Sólo mensajes humanos**: se descartan los de bots (`bot_id`), los editados o borrados
  (`subtype`) y los del propio bot (`botUserId`), para que lo que el agente publique no lo despierte.
- **Reconexión sola** cuando Slack cierra la conexión (`disconnect`, cada pocas horas) o se cae, con
  espera creciente (1 s → 30 s). `start()` tira si la PRIMERA conexión no se puede abrir.
- Un `onEvent` que tira se loguea y no corta la conexión.

## Configuración en Slack

1. *Socket Mode* activado y un app-level token con `connections:write` (`SLACK_APP_TOKEN`).
2. Eventos suscritos: `app_mention`, y `message.channels` / `message.groups` para las respuestas
   dentro de un hilo.
3. El bot invitado al canal.

Publicar sigue siendo del bot token: `@ia-flow/slack-api`.

## Tests

`bun run --filter @ia-flow/slack-socket test` (Vitest, en `src/**/tests/`).
