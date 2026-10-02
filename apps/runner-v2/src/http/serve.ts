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
import { createLogger, describeError, errorAttributes } from '@ia-flow/telemetry'
import type { MountedRunner } from '../boot.js'
import { type Delivery, deliveryScope } from '../intake/dispatch.js'
import { listenedTypes, RAW_PREFIX } from '../intake/listening.js'
import { type SlackIngressOptions, startSlackIngress } from '../intake/slackIngress.js'
import { createWebhookServer, GITHUB_WEBHOOK_PATH } from './server.js'

const telemetryLog = createLogger('ia-flow-runner-v2.serve')

export interface ServeOptions {
  port: number
  secret: string | undefined
  log: (line: string) => void
  /** Slack por Socket Mode (los mensajes llegan como `slack.message`). Sin esto, no se levanta. */
  slack?: SlackIngressOptions
  /** La API de la web, en el mismo puerto que los webhooks. */
  api?: { handle: NonNullable<Parameters<typeof createWebhookServer>[0]['api']>['handle'] }
  /** Cada delivery verificado, antes de despacharlo (la bandeja relee el board). */
  onDelivery?: (delivery: Delivery) => void
  /** Un delivery que no llega al engine: queda anotado igual, con por qué. */
  onIgnored?: (event: DomainEvent<any>, reason: string) => void
}

export async function serve(mounted: MountedRunner, opts: ServeOptions): Promise<Server> {
  const { log } = opts
  // Leído en cada delivery: las pipelines se recargan en caliente como el resto de `.config/`.
  const listened = () => listenedTypes(mounted)

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
        // Un `AggregateError` trae la causa de cada pipeline en `errors`: a la consola, todas en
        // la línea; a telemetría, el detalle completo (tipo, stack y cada causa) correlacionado.
        log(`  ${tag}: el despacho falló: ${describeError(err)}`)
        telemetryLog.error(`${tag}: el despacho falló`, {
          ...errorAttributes(err),
          'github.event': delivery.event,
          ...(delivery.id ? { 'github.delivery': delivery.id } : {}),
        })
      })
  }

  const server = createWebhookServer({
    secret: opts.secret,
    onDelivery,
    status: () => ({
      projects: mounted.projects.map((p) => ({
        id: p.id,
        board: mounted.boards.of(p.id).describe(),
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
  if (opts.slack) {
    const ingress = await startSlackIngress(mounted, mounted.services.slack, opts.slack)
    server.once('close', () => ingress?.stop())
  }
  if (!opts.secret?.trim()) {
    log('→ aviso: sin IA_FLOW_WEBHOOK_SECRET todo POST responde 503')
  }
  return server
}
