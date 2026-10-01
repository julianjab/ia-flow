# @ia-flow/slack-tools

Las `Action` de Slack que un agente pide por id — puente entre `@ia-flow/slack-api` y
`@ia-flow/agent-engine`:

| Action | Qué hace |
| --- | --- |
| `slack_read_thread` | El hilo completo desde el link de cualquiera de sus mensajes |
| `slack_channel_history` | Los últimos mensajes de un canal |
| `slack_post_message` | Publica en un canal o un hilo (escribe: necesita `allowWrite`) |

`request_slack_review` no vive acá: cruza el PR, su CI y el body del issue (GitHub), así que es
una action de runner-v2 (`src/actions/builtin/slack.ts`).
