/**
 * Un webhook crudo de GitHub, hacia el engine: `github.<evento>` con el payload tal cual y el scope
 * del delivery (para la traza). Lo usan el servidor (cada delivery verificado), `--event`,
 * `--replay-pr`, `--issue` y la bandeja (reintentar un evento). Qué hace el engine con él lo deciden las
 * pipelines de entrada (`resolve_task`).
 */
import { createEvent } from '@ia-flow/agent-engine'
import type { RawDelivery } from '../board/Board.js'
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
 * una task que no cumple el `when` del intake) se filtra igual.
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

/** Qué se simula sobre un issue (`--issue`): su card llegó a una columna, o le pusieron un label. */
export type IssueChange = { status: string } | { label: string }

/**
 * Un issue real con algo simulado (`--issue`), despachado como el webhook que GitHub mandaría:
 * por el intake, así corre exactamente lo que correría en producción —la regla de esa columna o la
 * de ese label—, con la card, el PR y los labels reales. No toca GitHub para simularlo: el label no
 * se pone y la card no se mueve. Lo que hagan después los agentes, sí es real.
 */
export async function simulateIssue(
  mounted: MountedRunner,
  target: { owner: string; repo: string; number: number },
  change: IssueChange,
  sender: string,
  log: (line: string) => void,
): Promise<void> {
  const ref = `${target.owner}/${target.repo}#${target.number}`
  const delivery =
    'status' in change
      ? await statusDelivery(mounted, ref, change.status, sender)
      : await labelDelivery(mounted, target, change.label, sender)
  const what =
    'status' in change ? `su card llegó a ${change.status}` : `le pusieron ${change.label}`
  log(`→ ${ref}: ${what} (como ${sender})`)
  await dispatchRaw(mounted, delivery, log)
}

/** "La card llegó a `status`": el board de la card arma el webhook (el mismo que re-ejecutar un
 *  review desde la bandeja). La card tiene que estar en un board del runner. */
async function statusDelivery(
  mounted: MountedRunner,
  ref: string,
  status: string,
  sender: string,
): Promise<RawDelivery> {
  for (const board of mounted.boards.all()) {
    const card = (await board.cards()).find((candidate) => candidate.ref === ref)
    if (card) return board.statusChange(card, status, sender)
  }
  throw new Error(`${ref} no está en ningún board del runner`)
}

/** "Le pusieron `label`": el `issues` `labeled` que manda GitHub, con el issue y el repo reales. */
async function labelDelivery(
  mounted: MountedRunner,
  target: { owner: string; repo: string; number: number },
  label: string,
  sender: string,
): Promise<RawDelivery> {
  const base = `/repos/${target.owner}/${target.repo}`
  const [issue, repository] = await Promise.all([
    mounted.github.requestJson<Record<string, unknown>>(`${base}/issues/${target.number}`),
    mounted.github.requestJson<Record<string, unknown>>(base),
  ])
  return {
    event: 'issues',
    id: `cli-${target.owner}-${target.repo}-${target.number}-${Date.now()}`,
    payload: {
      action: 'labeled',
      label: { name: label },
      issue,
      repository,
      sender: { login: sender },
    },
  }
}
