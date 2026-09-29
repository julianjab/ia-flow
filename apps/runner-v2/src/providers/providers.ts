/**
 * Los providers del runner, desde `providers:` de `runner.yaml`: `anthropic-api` (la Messages
 * API) y cualquier entrada con `type: claude-cli` (el CLI `claude`, con el id de su clave). Cada
 * entrada son los defaults de sus agentes, con la forma del `providerConfig` de cada uno, más
 * `maxConcurrent` (del provider, no de la corrida).
 */
import { type PipelineExecutionContext, providerRegistry } from '@ia-flow/agent-engine'
import { AnthropicProvider, parseAnthropicAgentConfig } from '@ia-flow/provider-anthropic'
import { ClaudeCliProvider, parseClaudeCliConfig } from '@ia-flow/provider-claude-cli'

export const ANTHROPIC_PROVIDER = 'anthropic-api'
export const CLAUDE_CLI_TYPE = 'claude-cli'

type ProvidersConfig = Record<string, Record<string, unknown>>

export interface RegisterProvidersOptions {
  /** El worktree de una corrida (donde corre una sesión del CLI). */
  cwd: (ctx: PipelineExecutionContext) => Promise<string>
  log: (line: string) => void
}

/** Registra en el `providerRegistry` global cada provider que declara `runner.yaml`. */
export function registerProviders(
  providers: ProvidersConfig,
  options: RegisterProvidersOptions,
): void {
  registerAnthropic(providers[ANTHROPIC_PROVIDER] ?? {}, options.log)
  for (const [id, config] of Object.entries(providers)) {
    if (config.type !== CLAUDE_CLI_TYPE) continue
    const { type: _type, maxConcurrent, bin, ...defaults } = config
    providerRegistry.register(
      new ClaudeCliProvider({
        id,
        cwd: options.cwd,
        ...parseClaudeCliConfig(defaults),
        ...(typeof bin === 'string' ? { bin } : {}),
        ...(typeof maxConcurrent === 'number' ? { maxConcurrent } : {}),
      }),
    )
  }
}

/** Cómo se valida el `providerConfig` de un agente, según su provider — al montar, para que un
 *  typo rompa el arranque y no la primera corrida. `undefined`: un provider que no se valida. */
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
    if (config.type !== CLAUDE_CLI_TYPE) continue
    const { type: _type, maxConcurrent: _max, bin: _bin, ...defaults } = config
    try {
      parseClaudeCliConfig(defaults)
    } catch (error) {
      throw new Error(`providers.${id}: ${(error as Error).message}`)
    }
  }
}

function registerAnthropic(config: Record<string, unknown>, log: (line: string) => void): void {
  const { maxConcurrent, ...runConfig } = config
  const { resumeMessages: _, ...defaults } = parseAnthropicAgentConfig(runConfig)
  providerRegistry.register(
    new AnthropicProvider({
      id: ANTHROPIC_PROVIDER,
      ...defaults,
      ...(typeof maxConcurrent === 'number' ? { maxConcurrent } : {}),
      model: process.env.ANTHROPIC_MODEL ?? defaults.model ?? 'claude-sonnet-5',
      onToolCall: (name, input) => log(`[tool] ${name} ${JSON.stringify(input).slice(0, 200)}`),
      onToolResult: (name, result) => log(`[tool:${name}] ${result.slice(0, 200)}`),
    }),
  )
}
