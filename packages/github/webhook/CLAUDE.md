# @ia-flow/github-webhook

Ver `README.md` para el contrato de uso; esto es guía específica para trabajar en el código.

## No depende de `@ia-flow/agent-engine`, a propósito

Lo único que "presta" hacia afuera es un objeto con la forma de `DomainEvent`
(`GithubWebhookEvent` — mismos campos: `type`, `payload`, `scope?`, `occurredAt`, `depth`), y esa
forma la declara ACÁ, sin importar el tipo real. TypeScript lo acepta en cualquier sitio tipado
`DomainEvent<any>` por matching estructural. Si `agent-engine` cambia la forma de
`DomainEvent`, este paquete NO se entera en tiempo de compilación — trade-off consciente: la
ganancia de ser 100% standalone (usable por cualquier engine) pesa más que la sincronía en
compile-time.

## No hay un traductor con opinión, a propósito

Hubo una versión anterior con una clase `GithubWebhookTranslator` que decidía el mapeo
`action` → nombre de evento DENTRO del paquete. Se sacó: ese mapeo es la pieza que une este
paquete con el engine/vocabulario de eventos de CADA app, no algo que el paquete pueda decidir
de una vez para todos. Lo que queda son los primitivos puros
(`parseGithubIssuePayload`/`parseGithubIssueCommentPayload`, `createGithubWebhookEvent`) para
que la app escriba su propio traductor como una función. Si te piden "agregar un evento nuevo"
acá, la respuesta casi siempre es "eso va en la función traductora de la app" — salvo que sea un
campo del payload de GitHub que ninguna función de parseo todavía extrae.

## Estructura

```
src/
├── GithubWebhookVerifier.ts   HMAC-SHA256 timing-safe de x-hub-signature-256
├── GithubWebhookEvent.ts      forma de DomainEvent (sin importarlo) + createGithubWebhookEvent
├── GithubIssuePayload.ts      parseGithubIssuePayload/parseGithubIssueCommentPayload — puras
├── GithubPullRequestPayload.ts  parseGithubPullRequestPayload/…ReviewPayload — puras
├── GithubCheckPayload.ts      parseGithubCheckPayload (check_suite + workflow_run) — pura
├── GithubProjectItemPayload.ts  parseGithubProjectItemPayload — pura
├── index.ts
└── tests/
```

## `GithubIssuePayload`/`GithubIssueCommentPayload` son `type`, no `interface`

Con `interface` sin index signature, TypeScript rechaza asignarlo a
`GithubWebhookEvent['payload']` (que resuelve a `Record<string, unknown>` por default de
genérico) con "Index signature for type 'string' is missing" — un `type` alias es asignable por
matching estructural sin más. Si agregás un payload nuevo, declaralo `type`.

## Antes de tocar código

```bash
bun run --filter @ia-flow/github-webhook typecheck
bun run --filter @ia-flow/github-webhook test
```

Source-only: sin build ni `dist/` — los `exports` apuntan a `src/*.ts` y los consumidores lo leen directo.
