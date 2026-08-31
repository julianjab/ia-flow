// Lo que el agent-host recuerda entre arranques: contra qué servers registrarse
// y con qué criterio admite trabajo.
//
// Un archivo JSON, no una DB: el agent-host es un proceso suelto que se levanta
// en cualquier máquina y su estado son dos campos. Vive en el config dir de
// ia-flow (`IA_FLOW_CONFIG_DIR`, igual que el resto), nunca en un path
// hardcodeado.
//
// **Lo guardado gana sobre el arranque en frío.** El `agent-host.yaml` y las
// env vars son la primera vez, o un deploy de docker-compose. Apenas alguien
// elige un server desde la pantalla, esa elección es la que manda: que un
// restart te devolviera al del archivo sería justamente perder lo que acabás
// de decidir.

import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { type AdmissionRule, isAdmissionRule } from './admission.js'
import type { AgentHostConfig } from './config.js'

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
  /** Base de los clones persistentes (`AGENT_HOST_REPOS_BASE`). */
  reposBase: string | null
  /** Base de los worktrees por task (`AGENT_HOST_WORKTREE_BASE`). */
  worktreeBase: string | null
  gitAuthorName: string | null
  gitAuthorEmail: string | null
}

export interface AgentHostState {
  /** Servers contra los que este agent-host se da de alta al bootear. */
  registerServerUrls: string[]
  /** Provider que expone. `null` = el de `AGENT_HOST_PROVIDER`. */
  providerId: string | null
  /** `null` = sin tope (mismo criterio que los caps del engine). */
  maxConcurrentRuns: number | null
  admissionRules: AdmissionRule[]
  workspace: WorkspaceSettings
}

const HOME = Bun.env.HOME ?? ''
const CONFIG_DIR = Bun.env.IA_FLOW_CONFIG_DIR ?? join(HOME, '.config', 'ia-flow')

export const STATE_FILE =
  Bun.env.IA_FLOW_AGENT_HOST_STATE_FILE ?? join(CONFIG_DIR, 'agent-host.json')

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
    reposBase: envOrNull('AGENT_HOST_REPOS_BASE'),
    worktreeBase: envOrNull('AGENT_HOST_WORKTREE_BASE'),
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
  const parsed = Number.parseInt(Bun.env.AGENT_HOST_MAX_CONCURRENT_RUNS ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

/**
 * El arranque en frío: el `agent-host.yaml` (ya volcado al entorno por
 * `applyAgentHostEnv`) más lo que quede en el env.
 *
 * `admissionRules` es el único campo que llega por parámetro y no por env, y
 * es a propósito: una lista de objetos en una variable de entorno sería un
 * JSON embutido en un string. Antes esto era `[]` fijo, o sea que un deploy
 * desatendido —el pod que bootea con su volumen vacío, sin nadie que abra la
 * pantalla— arrancaba admitiendo CUALQUIER tarea que le mandaran.
 */
export function defaultState(config?: AgentHostConfig | null): AgentHostState {
  return {
    registerServerUrls: envServerUrls(),
    providerId: null,
    maxConcurrentRuns: envMaxConcurrentRuns(),
    admissionRules: config?.admission?.rules?.filter(isAdmissionRule) ?? [],
    workspace: envWorkspace(),
  }
}

/**
 * Mezcla lo leído del archivo con el arranque en frío. Exportada porque es la
 * regla de precedencia del proceso —qué gana entre la pantalla, el
 * `agent-host.yaml` y el env— y esa regla se verifica sin tocar el disco.
 */
export function sanitizeState(raw: unknown, fallback: AgentHostState): AgentHostState {
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
    // Sin la clave manda el arranque en frío (el YAML), igual que `workspace`
    // abajo. Caer a `[]` acá hacía que CUALQUIER guardado desde la pantalla
    // —cambiar el provider, el cap, el workspace— se llevara puestas las
    // reglas declaradas, y en el próximo restart el agent-host admitiera todo
    // sin que nadie hubiera tocado una regla.
    admissionRules:
      'admissionRules' in r
        ? Array.isArray(r.admissionRules)
          ? r.admissionRules.filter(isAdmissionRule)
          : []
        : fallback.admissionRules,
    // Sin bloque guardado manda el env (arranque en frío); con bloque
    // guardado manda él, incluso si un campo quedó vacío a propósito.
    workspace:
      'workspace' in r ? sanitizeWorkspace(r.workspace, fallback.workspace) : fallback.workspace,
  }
}

export async function loadState(config?: AgentHostConfig | null): Promise<AgentHostState> {
  const fallback = defaultState(config)
  try {
    return sanitizeState(JSON.parse(await Bun.file(STATE_FILE).text()), fallback)
  } catch {
    // Primer arranque, o un archivo corrupto: el env manda y el próximo save
    // lo deja sano. Un agent-host que no bootea por un JSON roto es peor que uno
    // que arranca con sus defaults.
    return fallback
  }
}

export async function saveState(state: AgentHostState): Promise<void> {
  mkdirSync(dirname(STATE_FILE), { recursive: true })
  await Bun.write(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`)
}
