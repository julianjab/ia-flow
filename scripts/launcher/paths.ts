// Rutas que comparten todas las piezas del launcher. Vive aparte para que
// servers.ts / state.ts / run.ts no se importen entre sí sólo por esto.

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Raíz del repo — este archivo está en <root>/scripts/launcher/. */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

export const GATEWAY_DIR = join(REPO_ROOT, 'apps', 'ai-provider-gateway')

/** Puerto en el que escucha el gateway (su `PORT`, default 3002). */
export const GATEWAY_PORT = 3002

// Mismo default + mismo override que apps/server (infrastructure/db/database.ts):
// nunca hardcodear ~/.config/ia-flow.
const HOME = Bun.env.HOME ?? ''
const CONFIG_DIR = Bun.env.IA_FLOW_CONFIG_DIR ?? join(HOME, '.config', 'ia-flow')

/** Dónde recordamos la última elección del usuario. */
export const STATE_FILE = join(CONFIG_DIR, 'launcher.json')

/**
 * Scripts que Terminal ejecuta al abrirse — se reescriben en cada arranque.
 * Uno por app: si compartieran archivo, abrir una pisaría el script que la
 * otra está a punto de ejecutar.
 */
export const TERMINAL_SCRIPT = join(CONFIG_DIR, 'launcher-run.command')
export const TERMINAL_SCRIPT_GATEWAY = join(CONFIG_DIR, 'launcher-gateway.command')
