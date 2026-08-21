// Wiring del provider que esta instancia expone. Alcance de este primer
// corte (ver el plan): solo los `kind: 'sync'` — anthropic-api y
// claude-print — donde una llamada HTTP devuelve el resultado final.
// tmux-claude/iterm-claude quedan afuera: son `kind: 'async'`, spawnean su
// propia sesión de terminal local y necesitan que el `daemonUrl` (host que
// origina el dispatch) sea alcanzable para los callbacks de
// complete_task/fail_task — viable, pero se valida por separado una vez que
// el flujo sync esté probado end-to-end.
//
// anthropic-api corre acá SIN wiring de tools reales (repoPaths,
// WorkspaceManager, etc. no tienen sentido en un proceso standalone sin
// filesystem de proyecto) — un `ProviderInput.tools` vacío/ausente hace que
// `resolveTools` (packages/tools) nunca dispare ninguno de los tools que
// dependen de esos ports, así que no hace falta setearlos acá.
//
// Qué provider concreto corre detrás de `POST /v1/run` es una decisión
// puramente local a esta instancia — el server principal registra el
// gateway sin saber (ni necesitar saber) cuál de los dos implementa. Se
// resuelve acá vía `GATEWAY_PROVIDER` (default: anthropic-api).
import {
  AnthropicApiProvider,
  ClaudePrintProvider,
  DEFAULT_PROVIDER_CONFIG,
} from '@ia-flow/ai-providers'
import type { IAgentProvider } from '@ia-flow/ai-providers'
import { executeLoop, getToolDefinitions } from '@ia-flow/tools'
import { createLogger } from './logger.js'

const toolExecution = { getToolDefinitions, executeLoop }

async function loadProviderConfig() {
  return DEFAULT_PROVIDER_CONFIG
}

/** Construye el provider que esta instancia expone en `POST /v1/run`.
 *  Pensado para invocarse una sola vez al boot (`src/index.ts`); los tests
 *  pasan su propio fake provider. */
export function createProvider(): IAgentProvider {
  const kind = Bun.env.GATEWAY_PROVIDER ?? 'anthropic-api'

  if (kind === 'claude-print') {
    return new ClaudePrintProvider({ log: createLogger('claude-print') })
  }

  return new AnthropicApiProvider({
    toolExecution,
    loadProviderConfig,
    log: createLogger('anthropic-api'),
    // No hay directorio de proyecto donde persistir el log de contexto de
    // cada run — este proceso no tiene un working tree propio.
    skipContextLog: true,
  })
}
