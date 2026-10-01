/**
 * La bandeja y el asistente sobre un runner montado (`--serve`): los arma con el engine, la base de
 * actividad y GitHub, los conecta al stream de cambios y devuelve la API para el mismo puerto de
 * los webhooks. Composición: la lógica vive en cada pieza.
 */
import { createEvent } from '@ia-flow/agent-engine'
import type { RunnerStreamEvent } from '@ia-flow/shared'
import { Assistant } from '../assistant/Assistant.js'
import type { MountedRunner } from '../boot.js'
import type { RunnerConfig } from '../config/RunnerConfig.js'
import { DeviceFlow } from '../github/deviceFlow.js'
import type { ApiRouter } from '../http/ApiRouter.js'
import { GITHUB_WEBHOOK_PATH } from '../http/server.js'
import { SseHub } from '../http/sse.js'
import { dispatchRaw } from '../intake/dispatch.js'
import type { ActivityStore } from '../storage/activityStore.js'
import { taskOfKey } from './ActivityPort.js'
import { BoardReader, type BoardSpec } from './BoardReader.js'
import { configSummary } from './configSummary.js'
import { InboxService } from './InboxService.js'
import { IngressService } from './IngressService.js'
import { runnerApi } from './runnerApi.js'
import { toTraceEntry } from './SqliteActivity.js'
import { statusChangeWebhook } from './statusChangeWebhook.js'
import { TaskActions } from './TaskActions.js'

export interface MountedInbox {
  api: ApiRouter
  board: BoardReader
  close(): void
}

/** Cada cuánto se borra lo viejo de la base de actividad. */
const PRUNE_EVERY_MS = 3_600_000

export function mountInbox(
  mounted: MountedRunner,
  cfg: RunnerConfig,
  store: ActivityStore,
  options: { version: string; log: (line: string) => void },
): MountedInbox {
  const specs: BoardSpec[] = cfg.projects.map((project) => ({
    projectId: project.id,
    board: project.board,
    when: project.when,
  }))
  const board = new BoardReader(mounted.github)
  const inbox = new InboxService({
    projects: specs,
    board,
    activity: store.activity,
    waitingKeys: () => mounted.executions?.waitingKeys() ?? [],
    explain: async (event) => {
      const decisions = await mounted.engine.explain(
        createEvent(event.type, event.payload, { ...(event.scope ? { scope: event.scope } : {}) }),
      )
      return decisions.map((decision) => ({
        pipeline_id: decision.pipelineId,
        source_id: decision.sourceId,
        verdict: decision.verdict,
        ...(decision.reason ? { reason: decision.reason } : {}),
      }))
    },
    settings: cfg.inbox,
  })

  const hub = new SseHub<RunnerStreamEvent>()
  const changed = (ref: string | undefined) => {
    if (ref) hub.publish({ type: 'inbox', refs: [ref] })
  }
  const unsubscribe = [
    store.onTrace((record) => hub.publish({ type: 'trace', entry: toTraceEntry(record) })),
    store.onDispatch((entry) => changed(entry.event.scope?.issue as string | undefined)),
    mounted.executions?.observe((record) => changed(taskOfKey(record.key).taskRef)) ?? (() => {}),
  ]

  const actions = new TaskActions({
    inbox,
    boards: new Map(specs.map((spec) => [spec.projectId, spec.board])),
    settings: cfg.inbox,
    redispatch: async (ref, by) => {
      const last = store.activity.lastDispatchedEvent(ref)
      if (!last) throw new Error(`${ref} no tiene un evento que volver a despachar`)
      const event = createEvent(last.type, last.payload, {
        scope: { ...last.scope, redispatchedBy: by },
        parentId: last.id,
      })
      // Corre en segundo plano: una corrida de un agente dura minutos.
      mounted.engine.dispatch(event).catch((err: unknown) => {
        options.log(`relanzar ${ref}: ${err instanceof Error ? err.message : String(err)}`)
      })
      return `volví a despachar ${last.type}`
    },
    // Como si la persona hubiera movido la card a Review: el intake lee la card y el PR frescos, y
    // el pipeline de review corre con sus condiciones de siempre (PR abierto, sin blockers).
    rerunReview: async (ref, by) => {
      const card = await inbox.card(ref)
      if (!card?.itemId) throw new Error(`${ref} no está en el board`)
      const status = cfg.inbox.statuses.review
      const delivery = statusChangeWebhook({ itemId: card.itemId, status, sender: by })
      dispatchRaw(mounted, delivery, options.log).catch((err: unknown) => {
        options.log(
          `re-ejecutar review ${ref}: ${err instanceof Error ? err.message : String(err)}`,
        )
      })
      return `volví a correr ${status} para ${ref}`
    },
    stop: (ref, by) => {
      const running = store.activity.executions({
        taskRef: ref,
        statuses: ['running'],
        limit: 1,
      })[0]
      const execution = running ? mounted.executions?.current(running.key) : undefined
      const asked = execution?.interrupt(
        { by: 'inbox', event: 'inbox.stop', reason: `${by} pidió que pare desde la bandeja` },
        `${by} pidió desde la bandeja que termines ahora: cerrá tu turno con lo que tengas.`,
      )
      if (!asked) throw new Error(`${ref} no tiene un agente corriendo al que pedirle que pare`)
      return 'le pedí al agente que termine su turno'
    },
    changed: (ref) => {
      board.invalidate()
      changed(ref)
    },
  })

  const config = () =>
    configSummary({
      projects: specs.map((spec) => ({ id: spec.projectId, board: spec.board })),
      providers: cfg.providers,
      mcp: cfg.mcp,
      pipelines: () =>
        mounted.sources.flatMap(({ id, source }) =>
          source.list().map((pipeline) => ({ pipeline, sourceId: id })),
        ),
      routesOf: mounted.routesOf,
    })

  // El asistente es la capacidad `assistant` (un agente de la fuente global); sus tools leen de acá.
  mounted.services.assistant.connect({
    inbox,
    activity: store.activity,
    config,
    status: () => ({
      projects: specs.map((spec) => `${spec.projectId} (${spec.board.owner}#${spec.board.number})`),
      providers: Object.keys(cfg.providers),
      executions: mounted.executions?.stats,
      webhookSecret: Boolean(process.env.IA_FLOW_WEBHOOK_SECRET?.trim()),
      watchingInbox: hub.size,
    }),
  })
  const assistant = new Assistant({
    capabilities: mounted.engine.capabilities,
    desk: mounted.services.assistant,
    conversations: store.conversations,
  })

  const clientId = process.env.IA_FLOW_GITHUB_CLIENT_ID?.trim()
  const api = runnerApi({
    token: process.env.IA_FLOW_API_TOKEN,
    version: options.version,
    projects: specs.map((spec) => ({ id: spec.projectId, board: spec.board })),
    inbox,
    actions,
    assistant,
    conversations: store.conversations,
    ingress: new IngressService({
      log: store.activity,
      retentionDays: cfg.inbox.retentionDays,
      // Qué entradas tiene el runner lo dice su ambiente: sin el secret no acepta webhooks, sin el
      // app token no abre Slack.
      sources: [
        {
          id: 'github',
          name: 'GitHub',
          kind: 'webhook',
          endpoint: GITHUB_WEBHOOK_PATH,
          configured: Boolean(process.env.IA_FLOW_WEBHOOK_SECRET?.trim()),
          missing: 'IA_FLOW_WEBHOOK_SECRET',
        },
        {
          id: 'slack',
          name: 'Slack',
          kind: 'socket',
          configured: Boolean(process.env.SLACK_APP_TOKEN?.trim()),
          missing: 'SLACK_APP_TOKEN',
        },
      ],
    }),
    ...(clientId ? { deviceFlow: new DeviceFlow({ clientId }) } : {}),
    config,
    hub,
    log: options.log,
  })

  store.prune()
  const pruning = setInterval(() => store.prune(), PRUNE_EVERY_MS)
  pruning.unref()

  return {
    api,
    board,
    close: () => {
      clearInterval(pruning)
      for (const stop of unsubscribe) stop()
      hub.close()
    },
  }
}
