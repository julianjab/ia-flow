// Lo que el gateway recuerda entre arranques: contra qué servers registrarse
// y con qué criterio admite trabajo.
//
// Un archivo JSON, no una DB: el gateway es un proceso suelto que se levanta
// en cualquier máquina y su estado son dos campos. Vive en el config dir de
// ia-flow (`IA_FLOW_CONFIG_DIR`, igual que el resto), nunca en un path
// hardcodeado.
//
// **Lo guardado gana sobre el env.** `IA_FLOW_REGISTER_SERVER_URLS` es el
// arranque en frío — la primera vez, o un deploy de docker-compose. Apenas
// alguien elige un server desde la pantalla, esa elección es la que manda:
// que un restart te devolviera al del .env sería justamente perder lo que
// acabás de decidir.

import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { type AdmissionRule, isAdmissionRule } from './admission.js'

/**
 * Dónde aterriza el trabajo en ESTA máquina, y con qué identidad commitea.
 *
 * Vive acá y no sólo en el env porque es lo que un operador necesita cambiar
 * sin entrar por SSH a editar un `.env` y reiniciar: sin `reposBase`, un run
 * remoto que necesita un repo que esta máquina nunca vio falla con un error
 * explícito de `ensureLocalClone`.
 *
 * `null` en cualquiera = "no configurado": el WorkspaceManager cae a SU
 * default (worktrees efímeros en /tmp, autor `ia-flow-bot`). NO hay secretos
 * acá a propósito — este archivo se sirve por `GET /v1/workspace`, así que
 * `GITHUB_TOKEN` y `API_AI_PROVIDER_TOKEN` se quedan en el `.env`.
 */
export interface WorkspaceSettings {
  /** Base de los clones persistentes (`GATEWAY_REPOS_BASE`). */
  reposBase: string | null
  /** Base de los worktrees por task (`GATEWAY_WORKTREE_BASE`). */
  worktreeBase: string | null
  gitAuthorName: string | null
  gitAuthorEmail: string | null
}

export interface GatewayState {
  /** Servers contra los que este gateway se da de alta al bootear. */
  registerServerUrls: string[]
  /** Provider que expone. `null` = el de `GATEWAY_PROVIDER`. */
  providerId: string | null
  /** `null` = sin tope (mismo criterio que los caps del engine). */
  maxConcurrentRuns: number | null
  admissionRules: AdmissionRule[]
  workspace: WorkspaceSettings
}

const HOME = Bun.env.HOME ?? ''
const CONFIG_DIR = Bun.env.IA_FLOW_CONFIG_DIR ?? join(HOME, '.config', 'ia-flow')

export const STATE_FILE = Bun.env.IA_FLOW_GATEWAY_STATE_FILE ?? join(CONFIG_DIR, 'gateway.json')

function envServerUrls(): string[] {
  return (Bun.env.IA_FLOW_REGISTER_SERVER_URLS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** `undefined`/vacío → null, para que "no configurado" sea un solo valor. */
function envOrNull(name: string): string | null {
  const raw = Bun.env[name]?.trim()
  return raw ? raw : null
}

function envWorkspace(): WorkspaceSettings {
  return {
    reposBase: envOrNull('GATEWAY_REPOS_BASE'),
    worktreeBase: envOrNull('GATEWAY_WORKTREE_BASE'),
    gitAuthorName: envOrNull('IA_FLOW_GIT_AUTHOR_NAME'),
    gitAuthorEmail: envOrNull('IA_FLOW_GIT_AUTHOR_EMAIL'),
  }
}

/** Un campo de texto del estado: string no vacío, o null. Recorta para que
 *  un input con espacios no se guarde como "configurado". */
function textOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

export function sanitizeWorkspace(raw: unknown, fallback: WorkspaceSettings): WorkspaceSettings {
  if (!raw || typeof raw !== 'object') return fallback
  const r = raw as Record<string, unknown>
  return {
    reposBase: textOrNull(r.reposBase),
    worktreeBase: textOrNull(r.worktreeBase),
    gitAuthorName: textOrNull(r.gitAuthorName),
    gitAuthorEmail: textOrNull(r.gitAuthorEmail),
  }
}

function envMaxConcurrentRuns(): number | null {
  const parsed = Number.parseInt(Bun.env.GATEWAY_MAX_CONCURRENT_RUNS ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

/** Defaults del entorno — lo que valía antes de que este archivo existiera. */
export function defaultState(): GatewayState {
  return {
    registerServerUrls: envServerUrls(),
    providerId: null,
    maxConcurrentRuns: envMaxConcurrentRuns(),
    admissionRules: [],
    workspace: envWorkspace(),
  }
}

function sanitize(raw: unknown, fallback: GatewayState): GatewayState {
  if (!raw || typeof raw !== 'object') return fallback
  const r = raw as Record<string, unknown>
  const max = r.maxConcurrentRuns
  return {
    registerServerUrls: Array.isArray(r.registerServerUrls)
      ? r.registerServerUrls.filter((u): u is string => typeof u === 'string' && u.length > 0)
      : fallback.registerServerUrls,
    providerId: typeof r.providerId === 'string' ? r.providerId : null,
    // `0` y valores negativos se leen como "sin tope", igual que en el engine.
    maxConcurrentRuns: typeof max === 'number' && max > 0 ? max : null,
    admissionRules: Array.isArray(r.admissionRules) ? r.admissionRules.filter(isAdmissionRule) : [],
    // Sin bloque guardado manda el env (arranque en frío); con bloque
    // guardado manda él, incluso si un campo quedó vacío a propósito.
    workspace:
      'workspace' in r ? sanitizeWorkspace(r.workspace, fallback.workspace) : fallback.workspace,
  }
}

export async function loadState(): Promise<GatewayState> {
  const fallback = defaultState()
  try {
    return sanitize(JSON.parse(await Bun.file(STATE_FILE).text()), fallback)
  } catch {
    // Primer arranque, o un archivo corrupto: el env manda y el próximo save
    // lo deja sano. Un gateway que no bootea por un JSON roto es peor que uno
    // que arranca con sus defaults.
    return fallback
  }
}

export async function saveState(state: GatewayState): Promise<void> {
  mkdirSync(dirname(STATE_FILE), { recursive: true })
  await Bun.write(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`)
}
