# @ia-flow/github-webhook

Verificación de firma de webhooks de GitHub (`x-hub-signature-256`) + primitivos puros para
extraer campos de un payload — **standalone**, cero dependencias runtime, cero dependencia de
ningún engine.

## Instalar (dentro del monorepo)

```bash
bun run --filter @ia-flow/github-webhook test
```

## El traductor lo escribe la APP

Este paquete NO decide qué `action` de GitHub importa ni cómo se llama el evento resultante —
esa es la pieza que une este paquete con el engine que la app use (`@ia-flow/agent-engine` u
otro), y cada app tiene su propio vocabulario de eventos. Lo que el paquete expone son los
primitivos para que la app escriba ese traductor como una función simple:

```ts
import {
  createGithubWebhookEvent,
  GithubWebhookVerifier,
  parseGithubIssuePayload,
} from '@ia-flow/github-webhook';

const verifier = new GithubWebhookVerifier(process.env.GITHUB_WEBHOOK_SECRET!);

// Esta función es TUYA — mapeá action → type como tus Pipelines lo esperen.
function translate(eventType: string, payload: Record<string, unknown>) {
  if (eventType !== 'issues') return undefined;
  const action = payload.action;
  const type = { opened: 'github.issue.opened', closed: 'github.issue.closed' }[action as string];
  if (!type) return undefined;
  const issue = parseGithubIssuePayload(payload);
  return createGithubWebhookEvent(type, issue, { owner: issue.owner, repo: issue.repo });
}

// `rawBody` tiene que ser el string/Buffer CRUDO del request — la firma es sobre esos bytes.
if (!verifier.verify(rawBody, req.headers['x-hub-signature-256'])) {
  res.writeHead(401).end();
} else {
  const event = translate(req.headers['x-github-event'], JSON.parse(rawBody));
  if (event) await bus.publish(event); // agent-engine lo acepta tal cual — mismo shape que DomainEvent
}
```

`GithubWebhookEvent` tiene la misma FORMA que `DomainEvent` de `@ia-flow/agent-engine`
(`type`, `payload`, `scope?`, `occurredAt`, `depth`) sin importarlo — matching estructural.

## Lo que expone

```
GithubWebhookVerifier           HMAC-SHA256 timing-safe de x-hub-signature-256
parseGithubIssuePayload         extrae los campos de un payload `issues` — pura, sin decidir type
parseGithubIssueCommentPayload  igual, para `issue_comment`
parseGithubPullRequestPayload   `pull_request` — PR aplanado (head/base, merged, draft)
parseGithubPullRequestReviewPayload  igual + la review (`reviewState` en minúsculas)
parseGithubCheckPayload         `check_suite`/`workflow_run` a una forma común, con `kind`
parseGithubProjectItemPayload   `projects_v2_item` — node ids + campo cambiado (y from/to si vienen)
createGithubWebhookEvent        arma el GithubWebhookEvent alrededor de un `type` que VOS elegiste
```

## Lo que NO hace este paquete

- **No sirve un servidor HTTP** — todo acá es puro; montarlo detrás de un `node:http`, Hono, lo
  que sea, es trabajo del caller.
- **No decide el mapeo `action` → nombre de evento** — ver arriba.
