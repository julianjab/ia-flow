/**
 * Un evento crudo — misma FORMA que `DomainEvent` de `@ia-flow/agent-engine` (`type`,
 * `payload`, `scope?`, `occurredAt`, `depth`), pero SIN importar ese paquete (ver CLAUDE.md:
 * este package es standalone). Cualquier consumidor que tipe sus eventos como
 * `DomainEvent<any>` acepta este objeto tal cual por matching estructural.
 */
export interface GithubWebhookEvent<TPayload = Record<string, unknown>> {
  type: string
  payload: TPayload
  scope?: Record<string, unknown>
  occurredAt: string
  depth: number
}

/**
 * Arma un `GithubWebhookEvent` — el boilerplate de `occurredAt`/`depth` que cualquier
 * traductor de la APP necesitaría repetir. `type` es lo que el traductor de la app decide (ver
 * `webhook/README` — no lo decide este paquete); acá sólo se completa la forma alrededor.
 */
export function createGithubWebhookEvent<TPayload>(
  type: string,
  payload: TPayload,
  scope?: Record<string, unknown>,
): GithubWebhookEvent<TPayload> {
  return { type, payload, scope, occurredAt: new Date().toISOString(), depth: 0 }
}
