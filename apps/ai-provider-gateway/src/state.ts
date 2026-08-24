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

export interface GatewayState {
  /** Servers contra los que este gateway se da de alta al bootear. */
  registerServerUrls: string[]
  /** `null` = sin tope (mismo criterio que los caps del engine). */
  maxConcurrentRuns: number | null
  admissionRules: AdmissionRule[]
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

function envMaxConcurrentRuns(): number | null {
  const parsed = Number.parseInt(Bun.env.GATEWAY_MAX_CONCURRENT_RUNS ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

/** Defaults del entorno — lo que valía antes de que este archivo existiera. */
export function defaultState(): GatewayState {
  return {
    registerServerUrls: envServerUrls(),
    maxConcurrentRuns: envMaxConcurrentRuns(),
    admissionRules: [],
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
    // `0` y valores negativos se leen como "sin tope", igual que en el engine.
    maxConcurrentRuns: typeof max === 'number' && max > 0 ? max : null,
    admissionRules: Array.isArray(r.admissionRules) ? r.admissionRules.filter(isAdmissionRule) : [],
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
