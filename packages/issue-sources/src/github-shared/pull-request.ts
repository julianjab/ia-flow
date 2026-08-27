// Lectura/escritura del CUERPO de un PR. Vive acá y no en `issue.ts` porque un
// PR no es un Issue en el schema de GitHub (`updateIssue` no lo acepta), aunque
// las dos mutaciones se vean iguales.
//
// El único consumidor hoy es la sección `## Slack` (ver slack-section.ts):
// las fuentes que no tienen un campo propio donde guardar el link del hilo lo
// escriben en el body del PR.

import { gql } from './client.js'
import { extractSlackThreadUrl, upsertSlackSection } from './slack-section.js'

export async function getPullRequestBody(pullRequestId: string): Promise<string> {
  const data = await gql<{ node?: { body?: string } | null }>(
    `query PullRequestBody($id: ID!) {
      node(id: $id) { ... on PullRequest { body } }
    }`,
    { id: pullRequestId },
  )
  return data.node?.body ?? ''
}

export async function updatePullRequestBody(pullRequestId: string, body: string): Promise<void> {
  await gql(
    `mutation UpdatePullRequestBody($id: ID!, $body: String!) {
      updatePullRequest(input: { pullRequestId: $id, body: $body }) {
        pullRequest { id }
      }
    }`,
    { id: pullRequestId, body },
  )
}

/**
 * Guarda el link del hilo de Slack en la sección `## Slack` del PR.
 *
 * Lee el body antes de escribir a propósito: entre el pedido de review y este
 * write pudo pasar un agente editando la descripción, y `updatePullRequest`
 * reemplaza el body entero — mandar una copia vieja borraría ese trabajo.
 */
export async function saveSlackThreadUrlInPr(
  pullRequestId: string,
  threadUrl: string,
): Promise<void> {
  const body = await getPullRequestBody(pullRequestId)
  await updatePullRequestBody(pullRequestId, upsertSlackSection(body, threadUrl))
}

/** El link del hilo guardado en el PR, si lo hay. */
export async function readSlackThreadUrlFromPr(pullRequestId: string): Promise<string | undefined> {
  return extractSlackThreadUrl(await getPullRequestBody(pullRequestId))
}
