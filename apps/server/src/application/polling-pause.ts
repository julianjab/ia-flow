import type { IPollingGate } from '../domain/ports/IPollingGate.js'
import type { IProjectRepository } from '../domain/ports/IProjectRepository.js'
import { createLogger } from '../logger.js'

const log = createLogger('polling-pause')

// Lado durable del switch de polling.
//
// El gate (IPollingGate) sigue siendo la verdad en runtime: es lo que el
// dispatcher consulta en cada tick. Este servicio lo espeja en
// `projects.settings.pollingPaused` en cada flip y lo re-hidrata al bootear,
// para que un proyecto pausado siga pausado tras reiniciar el daemon.
const SETTING_KEY = 'pollingPaused'

export interface PauseResult {
  // false = el proyecto no existe (el caller responde 404).
  found: boolean
  // false = el flip quedó SÓLO en memoria (repo de sólo lectura o fallo de
  // escritura): al reiniciar el daemon se pierde. El caller lo propaga para
  // que la UI no prometa una durabilidad que no hubo.
  persisted: boolean
}

export function isPausedSetting(settings: Record<string, unknown> | undefined): boolean {
  return settings?.[SETTING_KEY] === true
}

export class PollingPauseService {
  constructor(
    private readonly repo: IProjectRepository,
    private readonly gate: IPollingGate,
  ) {}

  isPaused(projectId: string): boolean {
    return this.gate.isPaused(projectId)
  }

  listPaused(): string[] {
    return this.gate.listPaused()
  }

  // Corre una vez al bootear el daemon, ANTES de construir los managers, para
  // que el primer scan ya vea el estado persistido. Sólo proyectos activos: uno
  // archivado no se pollea, y dejarlo en el gate lo mostraría pausado para
  // siempre.
  hydrate(): string[] {
    const paused: string[] = []
    for (const project of this.repo.list()) {
      if (!isPausedSetting(project.settings)) continue
      this.gate.pause(project.id)
      paused.push(project.id)
    }
    return paused
  }

  setPaused(projectId: string, paused: boolean): PauseResult {
    const existing = this.repo.get(projectId)
    if (!existing) return { found: false, persisted: false }
    // Persistir PRIMERO: si la escritura falla (YamlProjectRepository es de
    // sólo lectura), flipear el gate antes dejaría el polling pausado con la
    // API respondiendo error — desincronizado y sin que el operador lo sepa.
    let persisted = true
    try {
      this.repo.upsert({
        id: existing.id,
        name: existing.name,
        language: existing.language,
        // Sólo tocamos el flag — el resto de settings es de otras features.
        settings: { ...(existing.settings ?? {}), [SETTING_KEY]: paused },
        source: existing.source,
      })
    } catch (err) {
      persisted = false
      log.warn({ err, projectId, paused }, 'pollingPaused no se persistió — queda sólo en memoria')
    }
    if (paused) this.gate.pause(projectId)
    else this.gate.resume(projectId)
    return { found: true, persisted }
  }
}
