import { crashRecoveryEnabled, startupScanEnabled } from '@ia-flow/issue-sources'
import {
  type EventProducer,
  IntervalEventProducer,
  RuleEngineHandler,
  WaitHandler,
  matchesCron,
  parseCron,
  scheduleTickEvent,
} from '@ia-flow/rules'
import {
  type EngineEvent,
  WAIT_EXPIRED,
  WAIT_RESUMED,
  createEvent,
  deriveEvent,
} from '@ia-flow/shared'
import { toRuleClassificationInput } from './application/rule-classification.js'
import { cachedVerdict, rememberVerdict } from './application/rule-whentext-cache.js'
import {
  registerActions,
  resolveRuleConversation,
  setActiveManagers,
} from './composition/actions.js'
import {
  actionRepo,
  actionRunRecorder,
  broadcast,
  buildManagers,
  classifyAgent,
  divergenceReconciler,
  eventBus,
  pollingPause,
  publishScannedItemUseCase,
  ruleRepo,
  waitRepo,
} from './composition/container.js'
import type { Disposable, IIssueManager, IssueItem } from './domain/ports/IIssueManager.js'
import { createLogger } from './logger.js'
import { daemonUrl } from './server-port.js'

const log = createLogger('daemon')

// Re-export broadcast.setFn for backward compatibility with index.ts
export function setBroadcast(fn: (msg: object) => void): void {
  broadcast.setFn(fn)
}

// Alive-set of running managers + their subscriptions. Held here so reload
// (see below) can dispose the previous generation cleanly before spawning
// the next one.
interface Running {
  manager: IIssueManager
  disposable: Disposable
}
let running: Running[] = []
// What the daemon is already managing, keyed by `${projectId}:${mode}` and
// reported by buildManagers — never derived from projectRepo.list(), which
// includes projects it skips (local kind, source without TransitionManager).
// Counting those as managed would deny them their first scan the day they get
// a usable source.
//
// A reload gives its catch-up pass only to keys missing here: a brand-new
// project, or one just switched polling→webhook, has never been scanned by
// this kind of manager — and in webhook mode nothing else would look at it
// until a delivery arrives (with no fallback timer, possibly never).
let managedKeys = new Set<string>()

const managedKey = (projectId: string, mode: string) => `${projectId}:${mode}`

// El scan publica un evento y el motor de reglas decide quién reacciona. El
// productor dejó de conocer a su consumidor, que es lo que permite que un
// `pr.opened` o un `ci.finished` entren por el mismo lugar sin tocar esta
// función.
//
// `publish` devuelve el outcome agregado porque `SourceDispatcher` lo necesita
// para decidir si el item vuelve al backlog; el bus no traga el `deferred`.
function startAll(managers: IIssueManager[]): Running[] {
  // Los handlers de acción necesitan resolver el manager de un proyecto para
  // poder correr un agente; se publican acá porque su ciclo de vida es el del
  // daemon, no el del container.
  setActiveManagers(managers)
  return managers.map((manager) => {
    const disposable = manager.start((item: IssueItem) => publishScannedItemUseCase.execute(item))
    return { manager, disposable }
  })
}

// El motor de reglas es UN suscriptor para todo el proceso, no uno por manager:
// el filtro por ámbito lo hace `matchScope` contra el scope del evento, no el
// cableado. Por eso se registra una vez en el boot y sobrevive a los reloads.
function registerRuleEngine(): void {
  registerActions()
  eventBus.subscribe(
    new RuleEngineHandler({
      // Por evento y no congelado: editar una regla en la UI tiene que
      // aplicar sin reiniciar el daemon.
      loadRules: (event) => ruleRepo.visibleTo(event.scope.projectId),
      // El `whenText` de una regla: un modelo lee el evento y dice si cumple.
      // Es el mismo clasificador que antes gateaba la activación de un agente
      // — lo que cambió es quién lo consulta. Un `null` (no se pudo decidir)
      // saltea la regla en vez de adivinar; ver RuleEngineHandler.
      //
      // La conversación es best-effort y se resuelve ANTES del clasificador,
      // no adentro: `toRuleClassificationInput` se queda pura (testeable sin
      // I/O) y `resolveRuleConversation` es lo único que sale a buscar datos.
      //
      // El cache evita repreguntarle a Haiku por un issue atascado en el
      // estado que activa la regla — ver rule-whentext-cache.ts. No evita la
      // llamada a `loadComments` de arriba: el cache sólo puede consultarse
      // una vez que la conversación (parte de su key) ya se armó.
      classifyRule: async ({ rule, event }) => {
        const conversation = await resolveRuleConversation(rule, event)
        const input = toRuleClassificationInput(rule, event, conversation)
        const cached = cachedVerdict(rule.id, input)
        if (cached !== undefined) return cached
        const verdict = await classifyAgent(input)
        if (verdict !== null) rememberVerdict(rule.id, input, verdict)
        return verdict
      },
      // Una `ref` se resuelve contra las acciones VISIBLES en el ámbito del
      // evento: las del proyecto más las globales. Por eso referenciar la
      // acción de otro proyecto no funciona — no porque se chequee, sino
      // porque nunca entra en el resultado.
      resolveAction: async (actionId, event) => {
        const visible = await actionRepo.visibleTo(event.scope.projectId)
        const found = visible.find((a) => a.id === actionId)
        // El nombre viaja al lado del cuerpo: es lo que la fila del listado
        // muestra en la columna del agente para una acción.
        return found ? { entry: found.body as never, name: found.name ?? found.id } : null
      },
      emit: async (cause, type, payload, scope) => {
        // `deriveEvent` y no `createEvent`: hereda causationId y depth+1, que
        // es lo único que impide que dos reglas que se emiten entre sí hagan
        // un loop infinito.
        await eventBus.publish(
          deriveEvent(cause, {
            type,
            source: 'rule',
            scope: scope ?? {},
            payload: payload ?? {},
          }),
        )
      },
      // Cada acción deja su fila en `execution_logs`, al lado del run que
      // corrió con ella. Sin esto, una acción `http` o `script` sólo existía
      // en una línea de log que rota — ver ExecutionActionRecorder.
      recorder: actionRunRecorder,
      onError: (err, { rule, position, kind }) =>
        log.error({ err, ruleId: rule.id, position, kind }, 'Rule action failed'),
      onMatch: ({ event, matched, rejected, rejectedSummary }) => {
        if (!matched.length) {
          // Antes esto era mudo: un evento que no matcheaba ninguna regla
          // desaparecía sin dejar rastro más allá del `outcome: skipped` del
          // borde HTTP, que no dice POR QUÉ. `rejectedSummary` es justo el
          // motivo por regla (disabled/type/scope/when/exclusive) — loguearlo
          // acá es lo que responde "¿por qué no corrió?" sin tener que
          // reproducir el evento a mano.
          log.info(
            {
              type: event.type,
              scope: event.scope,
              rejected: rejectedSummary,
              // Postmortem #1317: `rejectedSummary` dice QUE una regla cayó
              // por `when`, no POR QUÉ — para eso hubo que leer el código del
              // normalizador y reconstruir a mano qué campo faltaba. Con el
              // `whenTrace` de cada rechazo por `when`, la condición que
              // falló y el valor que el payload resolvió (`undefined` es la
              // señal más común de "este evento no trae ese campo") quedan
              // en la misma línea. Sólo las condiciones que fallaron, no
              // todo el trace — el resto es ruido para este log.
              rejectedWhen: rejected
                .filter((r) => r.whenTrace)
                .map((r) => ({
                  ruleId: r.id,
                  failed: r.whenTrace!.groups.flat().filter((c) => !c.matched),
                }))
                .filter((r) => r.failed.length > 0),
              // El payload crudo del evento — sin esto, "el campo vino
              // undefined" todavía obliga a adivinar si es que el evento no
              // lo trae nunca (bug de normalizador) o que este delivery en
              // particular vino incompleto.
              payload: event.payload,
              // Este evento queda igual marcado como procesado (el dedupe no
              // sabe de matches, ver bus.ts) — si lo que rechazó fue el `when`
              // y arreglaste la config, un reintento del mismo delivery id
              // (ej. "Redeliver" en GitHub) va a pisarse contra el dedupe. Este
              // curl lo saca de ahí para que la próxima entrega se reevalúe.
              clearDedupe: `curl -X DELETE '${daemonUrl()}/api/webhooks/dedupe/${encodeURIComponent(event.id)}' -H 'x-ia-flow-token: <IA_FLOW_WEBHOOK_SECRET>'`,
            },
            'Rules NOT matched',
          )
          return
        }
        log.info(
          {
            type: event.type,
            matched: matched.map((r) => r.id),
            rejected: rejectedSummary,
            // Mismo criterio que arriba: con qué payload matcheó, para poder
            // auditar "por qué se disparó ESTE agente en ESTE momento" sin
            // tener que cruzar el delivery de GitHub a mano.
            payload: event.payload,
          },
          'Rules matched',
        )
      },
    }),
  )
}

// Las esperas se suscriben APARTE del motor de reglas: son dos preguntas
// distintas sobre el mismo evento —"¿qué reglas aplican?" (config permanente)
// y "¿alguien estaba esperando esto?" (estado de runtime, de un solo uso)— y
// meterlas en un handler las acoplaría.
function registerWaits(): void {
  eventBus.subscribe(
    new WaitHandler({
      loadWaits: (projectId) => waitRepo.listByProject(projectId),
      consume: (waitId) => waitRepo.consume(waitId),
      resume: async (wait, event) => {
        // Reanudar es publicar: `wait.resumed` lleva el evento que despertó
        // dentro de su payload, así que la regla que corre al agente decide
        // qué hacer con él igual que con cualquier otro evento. El engine no
        // cablea "despertar" con "correr" — eso lo hace la config.
        await eventBus.publish(
          deriveEvent(event, {
            type: WAIT_RESUMED,
            source: 'engine',
            scope: { projectId: wait.projectId, issueId: wait.taskId },
            payload: {
              waitId: wait.id,
              agentId: wait.resumeWith ?? wait.agentId,
              // Una PAUSA trae checkpoint; una espera común, no.
              paused: wait.checkpoint != null,
              cause: { type: event.type, payload: event.payload },
            },
          }),
        )
        return 'dispatched'
      },
      onError: (err, { waitId, event }) =>
        log.error({ err, waitId, type: event.type }, 'Fallo al reanudar una espera'),
    }),
  )
}

/**
 * Barrido de esperas vencidas.
 *
 * Emite `wait.expired` por cada una: qué hacer con un timeout lo decide una
 * regla, no el engine. Sin esto, un CI que nunca corre porque el workflow
 * tenía un error de sintaxis dejaría la task esperando para siempre.
 */
const waitSweepProducer = new IntervalEventProducer({
  id: 'wait-sweep',
  intervalMs: waitSweepIntervalMs(),
  onError: (err) => log.error({ err }, 'Fallo el barrido de esperas vencidas'),
  produce: async (at) => {
    const events: EngineEvent[] = []
    for (const wait of await waitRepo.listExpired(at.toISOString())) {
      // Consumir primero, igual que al despertar: un barrido que se solapa
      // con el anterior no puede emitir dos veces el mismo vencimiento.
      if (!(await waitRepo.consume(wait.id))) continue
      log.info({ waitId: wait.id, taskId: wait.taskId, on: wait.on }, 'Espera vencida')
      events.push(
        createEvent({
          type: WAIT_EXPIRED,
          source: 'engine',
          scope: { projectId: wait.projectId, issueId: wait.taskId },
          payload: {
            waitId: wait.id,
            agentId: wait.resumeWith ?? wait.agentId,
            waitedFor: wait.on,
            paused: wait.checkpoint != null,
          },
        }),
      )
    }
    return events
  },
})

/**
 * Productor cron — `schedule.tick` por cada regla con `schedule`.
 *
 * Corre cada minuto, que es la granularidad de una expresión cron: menos no
 * puede disparar nada nuevo, y más se saltearía minutos enteros.
 *
 * El id del evento incluye la regla y el minuto exacto, así que es idempotente
 * por construcción: un tick que tarda más que el intervalo, o dos procesos a
 * la vez, producen el mismo id y el dedupe del bus se come el segundo.
 */
const cronProducer = new IntervalEventProducer({
  id: 'cron',
  intervalMs: 60_000,
  onError: (err) => log.error({ err }, 'Fallo el barrido de cron'),
  produce: async (at) => {
    const events: EngineEvent[] = []
    for (const rule of await ruleRepo.list()) {
      if (!rule.schedule || rule.enabled === false) continue
      const spec = parseCron(rule.schedule)
      if (!spec) {
        // Se avisa en cada tick a propósito: el CRUD ya rechaza una expresión
        // rota, así que llegar acá significa que la fila se escribió por otro
        // camino, y un log una sola vez se pierde.
        log.warn({ ruleId: rule.id, schedule: rule.schedule }, 'Expresión cron inválida')
        continue
      }
      if (!matchesCron(spec, at)) continue
      events.push(scheduleTickEvent(rule.id, at, rule.projectId))
    }
    return events
  },
})

/** Cada cuánto se buscan esperas vencidas. Un minuto: el vencimiento no
 *  necesita precisión —una espera de una hora tolera 60s de retraso— y un
 *  intervalo corto sería una query por minuto sin nada que hacer. */
function waitSweepIntervalMs(): number {
  const raw = Number(Bun.env.IA_FLOW_WAIT_SWEEP_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000
}

/**
 * Los productores por iniciativa de este proceso.
 *
 * Agregar uno es agregarlo a esta lista — no hay más cableado. Los de INGRESO
 * (webhooks) no están acá: su ciclo de vida es el del servidor HTTP y lo único
 * propio que tienen es el normalizador, que la ruta invoca. Ver
 * `EventProducer` en @ia-flow/rules para la diferencia.
 */
const PRODUCERS: EventProducer[] = [waitSweepProducer, cronProducer]

function startProducers(): void {
  for (const producer of PRODUCERS) {
    producer.start((event) => eventBus.publish(event))
    log.info({ producer: producer.id }, 'Productor de eventos arrancado')
  }
}

export async function startDaemon(): Promise<void> {
  // Real process boot: catch up on whatever moved while we were down.
  // Both passes are off-switchable, and each silence has a cost worth saying
  // out loud — otherwise "why is nothing happening?" is a log-less mystery.
  if (!startupScanEnabled()) {
    log.warn(
      'IA_FLOW_STARTUP_SCAN=0 — no boot scan: en modo webhook nada se despacha hasta el primer delivery',
    )
  }
  if (!crashRecoveryEnabled()) {
    log.warn(
      'IA_FLOW_CRASH_RECOVERY=0 — no se limpian flags `working` de runs muertos: esas tasks quedan trabadas',
    )
  }
  // Re-arm the pause switch before any manager exists, so a project paused
  // before the restart doesn't get one free scan on the way up.
  const paused = pollingPause.hydrate()
  if (paused.length) log.info({ paused }, 'Polling pausado (persistido) para estos proyectos')
  // Antes de levantar los managers: el motor de reglas tiene que estar
  // suscripto para no perderse los eventos del scan de boot.
  registerRuleEngine()
  registerWaits()
  const built = buildManagers({ boot: true })
  running = startAll(built.managers)
  managedKeys = built.keys
  // Process-lifetime, started once — never recreated by reloadManagers()
  // below. It doesn't depend on which managers are running, only on
  // pendingTasks + the live project/source config it re-resolves per tick.
  divergenceReconciler.start()
  startProducers()
  log.info({ count: running.length }, 'Daemon started')
}

// Called after any mutation to the projects table so the polling set matches
// current state (e.g. adding a project spins up a manager immediately, editing
// its URL swaps the underlying source, archiving stops the poll loop).
export function reloadManagers(): void {
  const prev = running.length
  for (const r of running) {
    try {
      r.disposable.dispose()
    } catch (err) {
      log.warn({ err }, 'Manager dispose threw — continuing')
    }
  }
  // boot:false — el daemon no se cayó, así que nadie corre crash-recovery (le
  // borraría el flag `working` a runs en vuelo). Los managers nuevos igual
  // hacen su primer scan: en modo webhook nada más los miraría.
  const known = managedKeys
  const built = buildManagers({
    boot: false,
    isNew: (projectId, mode) => !known.has(managedKey(projectId, mode)),
  })
  running = startAll(built.managers)
  managedKeys = built.keys
  log.info({ prev, next: running.length }, 'Managers reloaded')
}
