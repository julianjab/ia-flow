/**
 * Los providers del runner, desde `providers:` de `runner.yaml`: `anthropic-api` (la Messages
 * API) y cualquier entrada con `type: claude-cli` (el CLI `claude`, con el id de su clave). Cada
 * entrada son los defaults de sus agentes, con la forma del `providerConfig` de cada uno, más
 * `maxConcurrent` (del provider, no de la corrida).
 *
 * Los de otras máquinas no se declaran acá: un host se suscribe solo y aparece como
 * `remote:<name>` (ver `remoteHosts.ts`); los agentes lo nombran, o `remote:*`. El host arma el
 * suyo con lo mismo (`createProvider`), desde los `providers:` de SU runner.yaml.
 */
import {
  type PipelineExecutionContext,
  type Provider,
  providerRegistry,
} from '@ia-flow/agent-engine'
import { AnthropicProvider, parseAnthropicAgentConfig } from '@ia-flow/provider-anthropic-api'
import { ClaudeCliProvider, parseClaudeCliConfig } from '@ia-flow/provider-anthropic-cli'

export const ANTHROPIC_PROVIDER = 'anthropic-api'
export const CLAUDE_CLI_TYPE = 'claude-cli'

type ProvidersConfig = Record<string, Record<string, unknown>>

export interface RegisterProvidersOptions {
  /** El worktree de una corrida (donde corre una sesión del CLI). */
  cwd: (ctx: PipelineExecutionContext) => Promise<string>
  log: (line: string) => void
}

/** Registra en el `providerRegistry` global cada provider que declara `runner.yaml`, y los
 *  devuelve (un host presta uno de ellos). */
export function registerProviders(
  providers: ProvidersConfig,
  options: RegisterProvidersOptions,
): Provider[] {
  const registered: Provider[] = [
    registerAnthropic(providers[ANTHROPIC_PROVIDER] ?? {}, options.log),
  ]
  for (const [id, config] of Object.entries(providers)) {
    if (config.type === CLAUDE_CLI_TYPE) registered.push(claudeCli(id, config, options))
  }
  for (const provider of registered) providerRegistry.register(provider)
  return registered
}

/** Los ids de provider que declara `providers:`: `anthropic-api` siempre, y cada entrada
 *  `type: claude-cli`. */
export function providerIds(providers: ProvidersConfig): string[] {
  return [
    ANTHROPIC_PROVIDER,
    ...Object.entries(providers)
      .filter(([, config]) => config.type === CLAUDE_CLI_TYPE)
      .map(([id]) => id),
  ]
}

/** Un provider de `providers:`, armado como lo arma el runner — lo usa el host para correr el
 *  suyo. */
export function createProvider(
  id: string,
  providers: ProvidersConfig,
  options: RegisterProvidersOptions,
): Provider {
  if (id === ANTHROPIC_PROVIDER) return registerAnthropic(providers[id] ?? {}, options.log)
  const config = providers[id]
  if (config?.type === CLAUDE_CLI_TYPE) return claudeCli(id, config, options)
  throw new Error(`provider "${id}" desconocido (hay: ${providerIds(providers).join(', ')})`)
}

/** Cómo se valida el `providerConfig` de un agente, según su provider — al montar, para que un
 *  typo rompa el arranque y no la primera corrida. `undefined`: un provider que no se valida acá
 *  (`remote:*`: lo valida el host, que es el que sabe qué acepta). */
export function agentConfigValidator(
  providers: ProvidersConfig,
): (providerId: string) => ((raw: unknown) => void) | undefined {
  return (providerId) => {
    if (providerId === ANTHROPIC_PROVIDER) {
      return (raw) => void parseAnthropicAgentConfig(raw as Record<string, unknown>)
    }
    if (providers[providerId]?.type === CLAUDE_CLI_TYPE)
      return (raw) => void parseClaudeCliConfig(raw)
    return undefined
  }
}

/** Valida las entradas `claude-cli` de `runner.yaml` (sin registrarlas). */
export function validateProviderDefaults(providers: ProvidersConfig): void {
  for (const [id, config] of Object.entries(providers)) {
    try {
      if (config.type === CLAUDE_CLI_TYPE) {
        const { type: _type, maxConcurrent: _max, bin: _bin, ...defaults } = config
        parseClaudeCliConfig(defaults)
      }
    } catch (error) {
      throw new Error(`providers.${id}: ${(error as Error).message}`)
    }
  }
}

function registerAnthropic(config: Record<string, unknown>, log: (line: string) => void): Provider {
  const { maxConcurrent, ...runConfig } = config
  const { resumeMessages: _, ...defaults } = parseAnthropicAgentConfig(runConfig)
  return new AnthropicProvider({
    id: ANTHROPIC_PROVIDER,
    ...defaults,
    ...(typeof maxConcurrent === 'number' ? { maxConcurrent } : {}),
    model: process.env.ANTHROPIC_MODEL ?? defaults.model ?? 'claude-sonnet-5',
    onToolCall: (name, input) => log(`[tool] ${name} ${JSON.stringify(input).slice(0, 200)}`),
    onToolResult: (name, result) => log(`[tool:${name}] ${result.slice(0, 200)}`),
  })
}

function claudeCli(
  id: string,
  config: Record<string, unknown>,
  options: RegisterProvidersOptions,
): Provider {
  const { type: _type, maxConcurrent, bin, ...defaults } = config
  return new ClaudeCliProvider({
    id,
    cwd: options.cwd,
    ...parseClaudeCliConfig(defaults),
    ...(typeof bin === 'string' ? { bin } : {}),
    ...(typeof maxConcurrent === 'number' ? { maxConcurrent } : {}),
  })
}
