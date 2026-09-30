/**
 * Un webhook crudo de GitHub, hacia el engine: `github.<evento>` con el payload tal cual y el scope
 * del delivery (para la traza). Lo usan el servidor (cada delivery verificado), `--event`,
 * `--replay-pr` y la bandeja (reintentar un evento). Qué hace el engine con él lo deciden las
 * pipelines de entrada (`resolve_task`).
 */
import { createEvent } from '@ia-flow/agent-engine'
import type { MountedRunner } from '../boot.js'
import { RAW_PREFIX } from './listening.js'

/** Un delivery ya verificado, tal cual lo mandó GitHub. */
export interface Delivery {
  /** `X-GitHub-Event`. */
  event: string
  /** `X-GitHub-Delivery` — GitHub reintenta con el mismo id. */
  id?: string
  payload: Record<string, unknown>
}

type Raw = Record<string, Record<string, unknown> | undefined>

/** El scope de un delivery crudo, para la traza: el delivery id de GitHub y, si el payload los
 *  trae, el repo y el issue/PR. Los eventos que el intake derive cuelgan de esta misma traza. */
export function deliveryScope(delivery: Delivery): Record<string, string> {
  const raw = delivery.payload as Raw
  const repo = raw.repository?.full_name
  const number = raw.issue?.number ?? raw.pull_request?.number
  return {
    source: 'webhook',
    ...(delivery.id ? { deliveryId: delivery.id } : {}),
    ...(typeof repo === 'string' ? { repo } : {}),
    ...(typeof repo === 'string' && typeof number === 'number'
      ? { issue: `${repo}#${number}` }
      : {}),
  }
}

/** Un webhook crudo, despachado como un delivery (`--event`, `--replay-pr`). */
export async function dispatchRaw(
  mounted: MountedRunner,
  delivery: Delivery,
  log: (line: string) => void,
): Promise<void> {
  const outcome = await mounted.engine.dispatch(
    createEvent(`${RAW_PREFIX}${delivery.event}`, delivery.payload, {
      scope: deliveryScope(delivery),
    }),
  )
  log(`→ ${delivery.event}: ${outcome}`)
}

/**
 * Un PR real, despachado como si GitHub acabara de mandar su `pull_request` `opened`: lo lee de
 * la API y lo publica CRUDO (`github.pull_request`), así recorre el intake y las pipelines igual
 * que un delivery — sin túnel ni webhook de org. Lo que filtre el intake (card fuera del board,
 * sin la label del proyecto) se filtra igual.
 */
export async function replayPullRequest(
  mounted: MountedRunner,
  target: { owner: string; repo: string; number: number },
  log: (line: string) => void,
): Promise<void> {
  const pr = await mounted.github.requestJson<
    Record<string, unknown> & { base: { repo: unknown }; user: unknown }
  >(`/repos/${target.owner}/${target.repo}/pulls/${target.number}`)
  const delivery: Delivery = {
    event: 'pull_request',
    id: `replay-${target.owner}-${target.repo}-${target.number}-${Date.now()}`,
    payload: {
      action: 'opened',
      number: target.number,
      pull_request: pr,
      repository: pr.base.repo,
      sender: pr.user,
    },
  }
  log(`→ replay: ${target.owner}/${target.repo}#${target.number} como pull_request.opened`)
  await dispatchRaw(mounted, delivery, log)
}
