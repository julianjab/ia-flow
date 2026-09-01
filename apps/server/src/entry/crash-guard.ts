// Un fallo suelto no puede matar el daemon.
//
// Bun trata un `unhandledRejection` como fatal (Node, por default, sólo lo
// avisa) y un `uncaughtException` sin handler mata cualquier runtime. Los dos
// se llevaron puesto el proceso entero con runs en vuelo: el operador ve
// `error: script "prod" exited with code 1`, las tareas quedan con el flag
// `working` puesto y sus filas de `execution_logs` abiertas, y nadie comenta
// nada en el issue. El caso real que motivó esto fue un throw SINCRÓNICO
// adentro del `node:child_process` de Bun (`#getBunSpawnIo`) — o sea, código
// que no es nuestro y que ningún try/catch de un call site iba a cubrir.
//
// La regla acá: **el proceso sobrevive, el run no**. Un daemon vivo puede
// seguir recibiendo webhooks, cerrar los runs que siguen afuera y ser
// reiniciado a mano; uno muerto no puede hacer nada. Pero seguir con runs que
// perdieron su continuación es peor que cortarlos: se cancelan para que la
// maquinaria normal (abort → `Agent.run` cierra la fila → `onError` comenta y
// mueve el issue) los reporte como fallidos en vez de dejarlos colgados.
//
// La misma distinción que el shutdown por señal (ver `entry/server.ts`): un
// run con sesión async (tmux/iterm, o un agent-host remoto) NO muere con este
// proceso — su agente sigue trabajando afuera y su cierre lo va a recibir el
// rehidratador. Cancelarlo tiraría trabajo hecho a la basura.
import type { PendingTask } from '@ia-flow/agent-engine'

export type FatalKind = 'uncaughtException' | 'unhandledRejection'

/** Qué hacer con el proceso después de cancelar los runs. `survive` (default)
 *  lo deja vivo; `exit` sale con código 1 para que un supervisor (docker
 *  restart, systemd) lo levante limpio. */
export type FatalPolicy = 'survive' | 'exit'

/** El mínimo de pino que este módulo usa. Declarado acá para que el guard se
 *  pueda testear con un logger de mentira. */
export interface CrashLogger {
  error(obj: object, msg: string): void
  warn(obj: object, msg: string): void
}

export interface CrashGuardDeps {
  listPending: () => Array<[string, PendingTask]>
  removePending: (
    taskId: string,
    finish: { cancelled?: boolean; finalizedByTool?: boolean; reason?: string },
  ) => void
  log: CrashLogger
  /** True mientras el shutdown ordenado está en curso: ahí un rejection de un
   *  fetch abortado es esperable y no hay nada que cancelar. */
  isShuttingDown?: () => boolean
  /** Se lee en cada fatal, no al instalar: el guard se engancha antes de que
   *  `envRepo.loadIntoProcess()` haya traído lo que el operador guardó en la
   *  DB, así que congelar el valor al arranque ignoraría esa edición. */
  policy?: () => FatalPolicy
  /** Inyectable para testear la rama `exit` sin matar al runner de tests. */
  exit?: (code: number) => void
}

export function resolveFatalPolicy(raw: string | undefined): FatalPolicy {
  return raw?.trim().toLowerCase() === 'exit' ? 'exit' : 'survive'
}

function describe(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`
  return String(err)
}

/**
 * Cancela los runs que este proceso estaba corriendo y devuelve sus ids.
 *
 * `entry.cancel()` es el MISMO camino que usa el cancel manual de la UI:
 * aborta el fetch del provider, mata la sesión si la hay y limpia el flag
 * `working`. El cierre de la fila y el comentario los hace el orquestador
 * cuando su `provider.run` rechaza — no los duplicamos acá.
 *
 * Cuando la entrada todavía no tiene `cancel` (registrada, pero el provider
 * no arrancó), se la saca a mano: si no, su `waitForFinish` no resuelve nunca
 * y el slot de capacidad queda ocupado hasta el reinicio.
 */
export async function cancelInFlight(
  reason: string,
  deps: Pick<CrashGuardDeps, 'listPending' | 'removePending' | 'log'>,
): Promise<{ cancelled: string[]; detached: string[] }> {
  const pending = deps.listPending()
  const detached = pending.filter(([, e]) => e.killSession != null).map(([id]) => id)
  const cancellable = pending.filter(([, e]) => e.killSession == null)

  await Promise.allSettled(
    cancellable.map(async ([taskId, entry]) => {
      try {
        if (entry.cancel) await entry.cancel()
        else deps.removePending(taskId, { cancelled: true, reason })
      } catch (err) {
        deps.log.warn({ taskId, err }, 'El cancel del run falló durante el fatal')
        deps.removePending(taskId, { cancelled: true, reason })
      }
    }),
  )

  return { cancelled: cancellable.map(([id]) => id), detached }
}

/** Cuántos fatales lleva el proceso. Sólo informativo — sube en el log para
 *  que un daemon que sobrevive a diez seguidos se note en vez de disimularse. */
let fatalCount = 0

export async function handleFatal(
  kind: FatalKind,
  err: unknown,
  deps: CrashGuardDeps,
): Promise<void> {
  fatalCount += 1
  const count = fatalCount
  const reason = `fatal: ${kind} — ${describe(err)}`

  if (deps.isShuttingDown?.()) {
    deps.log.warn({ kind, err, count }, 'Fatal durante el shutdown — se ignora')
    return
  }

  const policy = deps.policy?.() ?? 'survive'
  deps.log.error(
    { kind, err, count, policy },
    'Fallo no capturado — se cancelan los runs en vuelo para que se reporten',
  )

  let cancelled: string[] = []
  let detached: string[] = []
  try {
    ;({ cancelled, detached } = await cancelInFlight(reason, deps))
  } catch (cleanupErr) {
    // El guard es lo último que queda en pie: que su propia limpieza falle no
    // puede ser lo que termine matando al proceso.
    deps.log.warn({ err: cleanupErr }, 'La cancelación de runs falló durante el fatal')
  }

  deps.log.warn(
    { kind, count, cancelled, detached, policy },
    policy === 'exit'
      ? 'Runs cancelados — saliendo (IA_FLOW_FATAL_POLICY=exit)'
      : 'Runs cancelados — el daemon sigue vivo',
  )

  if (policy === 'exit') (deps.exit ?? process.exit)(1)
}

/** Engancha los dos eventos fatales. Devuelve la función que los desengancha
 *  (la usan los tests; en producción el guard vive lo que vive el proceso). */
export function installCrashGuard(deps: CrashGuardDeps): () => void {
  const onException = (err: unknown) => void handleFatal('uncaughtException', err, deps)
  const onRejection = (err: unknown) => void handleFatal('unhandledRejection', err, deps)
  // `bun-types` declara `process.on` sólo con sus propias sobrecargas y no con
  // las de Node, así que ninguna matchea estos dos eventos y TS reporta la
  // última que conoce (`memoryPressure`) — un mensaje que no señala a la causa.
  // El cast es al emisor de Node, que es lo que Bun implementa en runtime; no
  // afloja el tipado de los handlers, que siguen chequeados arriba.
  const emitter = process as unknown as {
    on(event: string, listener: (arg: unknown) => void): void
    off(event: string, listener: (arg: unknown) => void): void
  }
  emitter.on('uncaughtException', onException)
  emitter.on('unhandledRejection', onRejection)
  return () => {
    emitter.off('uncaughtException', onException)
    emitter.off('unhandledRejection', onRejection)
  }
}
