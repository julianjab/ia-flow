/**
 * Modo servidor (`--serve`): el engine se monta UNA vez y cada delivery de GitHub recorre
 *
 *   server.ts (firma, 202) → engine.dispatch(github.<evento>, payload crudo)
 *     → el intake (`sources.pipelines` de runner.yaml: `intake`, con `resolve_task`) → las del proyecto
 *
 * Cada delivery se despacha en el acto, sin cola: la serie por task y el tope global son de las
 * EJECUCIONES del engine (en SQLite, ver `engine.yaml`). Así un comentario que llega
 * mientras el implementer trabaja pasa por el intake enseguida y, si el implementer lo acepta
 * (sus `injects`), le llega en su próxima vuelta en vez de esperar a que termine.
 *
 * Acá no se traduce nada: completar el evento con lo que necesita el agente es trabajo de las
 * pipelines de entrada del proyecto (`resolve_task`).
 */
import type { Server } from 'node:http'
import { createEvent, type DomainEvent } from '@ia-flow/agent-engine'
import type { MountedRunner } from './boot.js'
import { createWebhookServer, type Delivery, GITHUB_WEBHOOK_PATH } from './server.js'

export interface ServeOptions {
  port: number
  secret: string | undefined
  log: (line: string) => void
  /** La API de la web, en el mismo puerto que los webhooks. */
  api?: { handle: NonNullable<Parameters<typeof createWebhookServer>[0]['api']>['handle'] }
  /** Cada delivery verificado, antes de despacharlo (la bandeja relee el board). */
  onDelivery?: (delivery: Delivery) => void
  /** Un delivery que no llega al engine: queda anotado igual, con por qué. */
  onIgnored?: (event: DomainEvent<any>, reason: string) => void
}

type Raw = Record<string, Record<string, unknown> | undefined>

/** El prefijo de los eventos crudos que publica el servidor de webhooks: `github.<evento>`. */
export const RAW_PREFIX = 'github.'

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

export async function serve(mounted: MountedRunner, opts: ServeOptions): Promise<Server> {
  const { log } = opts
  // Leído en cada delivery: las pipelines se recargan en caliente como el resto de `.config/`.
  const listened = () =>
    new Set(
      mounted
        .pipelines()
        .flatMap((pipeline) => pipeline.on)
        .filter((type) => type.startsWith(RAW_PREFIX)),
    )

  const onDelivery = async (delivery: Delivery) => {
    opts.onDelivery?.(delivery)
    const type = `${RAW_PREFIX}${delivery.event}`
    const action = typeof delivery.payload.action === 'string' ? `.${delivery.payload.action}` : ''
    const event = createEvent(type, delivery.payload, { scope: deliveryScope(delivery) })
    // Sin pipeline de entrada para el evento no hay nada que despachar.
    if (!listened().has(type)) {
      log(`· ${delivery.event}${action} (${delivery.id ?? 'sin id'}): ningún intake lo escucha`)
      opts.onIgnored?.(event, 'ningún intake lo escucha')
      return
    }
    const tag = `${delivery.event}${action} (${delivery.id ?? 'sin id'})`
    mounted.engine
      .dispatch(event)
      .then((outcome) => {
        if (outcome === 'skipped') log(`· ${tag}: filtrado por el intake`)
      })
      .catch((err: unknown) => {
        log(`  ${tag}: el despacho falló: ${err instanceof Error ? err.message : String(err)}`)
      })
  }

  const server = createWebhookServer({
    secret: opts.secret,
    onDelivery,
    status: () => ({
      projects: mounted.projects.map((p) => ({
        id: p.id,
        board: `${p.board.owner}#${p.board.number}`,
      })),
      listening: [...listened()].sort(),
      executions: mounted.executions?.stats,
    }),
    ...(opts.api ? { api: opts.api } : {}),
    log,
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port, () => resolve())
  })
  // Las pausas que vencen (`timeout`) las revisa el engine solo: `tick.everyMs` de engine.yaml.
  log(`→ escuchando webhooks en http://localhost:${opts.port}${GITHUB_WEBHOOK_PATH}`)
  if (!opts.secret?.trim()) {
    log('→ aviso: sin IA_FLOW_WEBHOOK_SECRET todo POST responde 503')
  }
  return server
}
