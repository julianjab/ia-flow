// Qué variables tiene sentido configurar EN ESTE proceso.
//
// El catálogo con las descripciones sigue en `routes/env-vars.ts`; lo que se
// arma acá es la lista de nombres **relevantes**, juntando lo que cada dueño
// declara. La ruta intersecta las dos.
//
// Por qué el ensamblado vive en `composition/` y no en la ruta: es la única
// capa que sabe qué se cableó. La ruta no tiene por qué enterarse de si este
// proceso registró providers de terminal o si hay agent-hosts remotos — y si lo
// supiera, cada flavor nuevo obligaría a tocarla.
import { STATIC_TOKEN_VAR } from '@ia-flow/figma-auth'
import { DISPATCH_CONFIG_VARS } from '@ia-flow/issue-sources'
import { githubCredentials, providerRegistry } from './container.js'
import { getPreloadedConfig } from './preloaded.js'

/** Siempre: cualquier proceso loguea, y la telemetría no es opcional en
 *  ningún build (ver apps/server/RUNNER-DEPLOY.md). */
const ALWAYS = [
  'LOG_LEVEL',
  // Cualquier proceso engancha el crash guard (entry/crash-guard.ts).
  'IA_FLOW_FATAL_POLICY',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_SDK_DISABLED',
]

/** Credenciales del modelo. Las declara quien las lee: `buildAnthropicAuthHeader`
 *  (packages/ai-providers/src/anthropic-api/auth.ts) prueba el token OAuth y
 *  después la API key. */
const ANTHROPIC_VARS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'IA_FLOW_FILE_SIMPLIFIER']

const REMOTE_PROVIDER_VARS = [
  'IA_FLOW_REMOTE_HEALTH_INTERVAL_MS',
  'IA_FLOW_REMOTE_HEALTH_TIMEOUT_MS',
]

const WEBHOOK_VARS = ['IA_FLOW_DAEMON_MODE', 'IA_FLOW_WEBHOOK_SECRET']

const CATCH_UP_VARS = ['IA_FLOW_STARTUP_SCAN', 'IA_FLOW_CRASH_RECOVERY']

/**
 * Los nombres relevantes, en orden de especificidad.
 *
 * Es una **función** y no una constante porque la respuesta cambia con la
 * config: cambiar el modo de auth de GitHub desde la UI cambia qué campos
 * tiene sentido mostrar, sin reiniciar. Un array congelado al importar
 * seguiría ofreciendo un PAT a un daemon que corre como App.
 */
export function relevantConfigVars(): Set<string> {
  const names = new Set<string>()

  // La estrategia de credenciales decide sus propias variables según el modo
  // que ganó. Es el caso que motivó todo esto.
  for (const name of githubCredentials.describeConfig()) names.add(name)

  // Slack se ofrece SIEMPRE, aunque esté apagado: su token es justamente el
  // interruptor (ver packages/slack/CLAUDE.md), así que esconder el campo
  // cuando falta lo dejaría imposible de prender desde esta pantalla.
  names.add('SLACK_BOT_TOKEN')
  names.add('SLACK_SIGNING_SECRET')

  // El escape hatch del MCP de Figma. El camino normal es `bun run auth:figma`
  // (deja una sesión OAuth que se renueva sola y no vive en el env); este
  // campo es para el deploy headless que no puede abrir un browser.
  names.add(STATIC_TOKEN_VAR)

  for (const name of [...WEBHOOK_VARS, ...CATCH_UP_VARS, ...DISPATCH_CONFIG_VARS]) {
    names.add(name)
  }

  // Los knobs de salud de remotos sólo valen si este proceso los sondea. Un
  // entrypoint que apaga el monitor no debería ofrecer un intervalo que nadie
  // va a leer.
  if (getPreloadedConfig().remoteProviders !== false) {
    for (const name of REMOTE_PROVIDER_VARS) names.add(name)
  }

  // Las credenciales del modelo, sólo si hay algún provider registrado que
  // llame a Anthropic directo. Un proceso que despacha todo a agent-hosts
  // remotos no necesita la API key acá.
  // `list()` y no `get()`: este último tira cuando el id no está registrado.
  if (providerRegistry.list().some((p) => p.id === 'anthropic-api')) {
    for (const name of ANTHROPIC_VARS) names.add(name)
  }

  for (const name of ALWAYS) names.add(name)

  return names
}
