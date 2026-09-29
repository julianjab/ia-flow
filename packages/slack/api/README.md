# @ia-flow/slack-api

Cliente delgado de la Web API de Slack con un bot token (`xoxb-…`), sin SDK y con `fetch`
inyectable. Standalone: no depende del engine.

- `SlackClient({ token })` — `postMessage` (en un canal o un hilo), `permalink`, `replies`,
  `history`, `userName` (cacheado). `enabled` dice si hay token; sin él, cada llamada tira
  diciendo que falta `SLACK_BOT_TOKEN`. Un `ok: false` de Slack tira con su `error`.
- `parseSlackPermalink` / `threadTsOf` — de un link de mensaje a canal + `ts` (y el del hilo).
- `review.ts` — el pedido de review, puro: a quién taguear y en qué canal
  (`resolveSlackReviewTarget`, repo sobre proyecto campo por campo), por qué no se puede
  (`slackReviewBlockedReason`) y el texto (`buildSlackReviewMessage`, primer pedido o re-review).

Scopes: `chat:write`; `channels:history`/`groups:history` para leer; `users:read` para nombres.
