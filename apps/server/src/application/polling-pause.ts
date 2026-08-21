import { pauseProject, resumeProject } from '@ia-flow/issue-sources'
import type { IProjectRepository } from '../domain/ports/IProjectRepository.js'
import { createLogger } from '../logger.js'

const log = createLogger('polling-pause')

// Durable side of the polling pause switch.
//
// The runtime gate lives in @ia-flow/issue-sources (dispatch/polling-pause.ts):
// an in-memory Set the poll loop checks on every tick. That set is still the
// source of truth at runtime — this module only mirrors it into
// `projects.settings.pollingPaused` on every write and re-hydrates it at boot,
// so a paused project stays paused across a daemon restart.
const SETTING_KEY = 'pollingPaused'

export function isPausedSetting(settings: Record<string, unknown> | undefined): boolean {
  return settings?.[SETTING_KEY] === true
}

// Called once at daemon boot, BEFORE the managers are built, so the first scan
// already sees the persisted state.
export function hydratePausedProjects(repo: IProjectRepository): string[] {
  const paused: string[] = []
  // Sólo los activos: un proyecto archivado no se pollea, y dejarlo en el set
  // lo mostraría como "pausado" para siempre.
  for (const project of repo.list()) {
    if (!isPausedSetting(project.settings)) continue
    pauseProject(project.id)
    paused.push(project.id)
  }
  return paused
}

// Flips the in-memory gate and persists it. Returns false when the project is
// unknown (caller answers 404), true when the flip was applied.
export function setProjectPaused(repo: IProjectRepository, id: string, paused: boolean): boolean {
  const existing = repo.get(id)
  if (!existing) return false
  // Persistir PRIMERO: si el repo es de sólo lectura (YamlProjectRepository)
  // el upsert tira, y flipear el gate antes dejaría el polling pausado con la
  // API respondiendo error — desincronizado y sin que el operador lo sepa.
  try {
    repo.upsert({
      id: existing.id,
      name: existing.name,
      language: existing.language,
      // Only touch the flag — the rest of settings is owned by other features.
      settings: { ...(existing.settings ?? {}), [SETTING_KEY]: paused },
      source: existing.source,
    })
  } catch (err) {
    // Repo de sólo lectura: degradamos a pausa en memoria (el comportamiento
    // que este switch tenía antes de persistirse) en vez de fallar el request.
    log.warn({ err, id, paused }, 'No se pudo persistir pollingPaused — queda sólo en memoria')
  }
  if (paused) pauseProject(id)
  else resumeProject(id)
  return true
}
