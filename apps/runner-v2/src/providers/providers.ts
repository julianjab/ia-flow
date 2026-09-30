/**
 * Los providers del runner, desde `providers:` de `runner.yaml`: `anthropic-api` (la Messages
 * API), cualquier entrada con `type: claude-cli` (el CLI `claude`, con el id de su clave) y
 * cualquiera con `type: remote` (un provider que corre en otra máquina, detrás de un
 * `RemoteProviderHost` — ver `--host`). Cada entrada local son los defaults de sus agentes, con la
 * forma del `providerConfig` de cada uno, más `maxConcurrent` (del provider, no de la corrida).
 */
import {
  type PipelineExecutionContext,
  type Provider,
  providerRegistry,
} from '@ia-flow/agent-engine'
import { AnthropicProvider, parseAnthropicAgentConfig } from '@ia-flow/provider-anthropic'
import { ClaudeCliProvider, parseClaudeCliConfig } from '@ia-flow/provider-claude-cli'
import {
  type AdmissionHints,
  parseRemoteProviderConfig,
  RemoteProvider,
  type RemoteProviderConfig,
} from '@ia-flow/provider-remote'

export const ANTHROPIC_PROVIDER = 'anthropic-api'
export const CLAUDE_CLI_TYPE = 'claude-cli'
export const REMOTE_TYPE = 'remote'

type ProvidersConfig = Record<string, Record<string, unknown>>

export interface RegisterProvidersOptions {
  /** El worktree de una corrida (donde corre una sesión del CLI). */
  cwd: (ctx: PipelineExecutionContext) => Promise<string>
  log: (line: string) => void
}

/** Registra en el `providerRegistry` global cada provider que declara `runner.yaml`, y los
 *  devuelve (los locales son los que `--host` puede exponer). */
export function registerProviders(
  providers: ProvidersConfig,
  options: RegisterProvidersOptions,
): Provider[] {
  const registered: Provider[] = [
    registerAnthropic(providers[ANTHROPIC_PROVIDER] ?? {}, options.log),
  ]
  for (const [id, config] of Object.entries(providers)) {
    if (config.type === CLAUDE_CLI_TYPE) registered.push(claudeCli(id, config, options))
    else if (config.type === REMOTE_TYPE) registered.push(remote(id, config))
  }
  for (const provider of registered) providerRegistry.register(provider)
  return registered
}

/** Cómo se valida el `providerConfig` de un agente, según su provider — al montar, para que un
 *  typo rompa el arranque y no la primera corrida. `undefined`: un provider que no se valida (uno
 *  remoto: lo valida el provider del host, que es el que sabe qué acepta). */
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

/** Valida las entradas `claude-cli` y `remote` de `runner.yaml` (sin registrarlas). */
export function validateProviderDefaults(providers: ProvidersConfig): void {
  for (const [id, config] of Object.entries(providers)) {
    try {
      if (config.type === CLAUDE_CLI_TYPE) {
        const { type: _type, maxConcurrent: _max, bin: _bin, ...defaults } = config
        parseClaudeCliConfig(defaults)
      } else if (config.type === REMOTE_TYPE) {
        remoteConfig(config)
      }
    } catch (error) {
      throw new Error(`providers.${id}: ${(error as Error).message}`)
    }
  }
}

/** Las pistas que el host usa en sus reglas, además de agente, tipo de evento y scope: el repo
 *  de la task (`owner/repo`), si el evento lo trae. */
export function runnerHints(ctx: PipelineExecutionContext): AdmissionHints {
  const { owner, repo } = (ctx.event.payload ?? {}) as { owner?: unknown; repo?: unknown }
  return typeof owner === 'string' && typeof repo === 'string' ? { repo: [`${owner}/${repo}`] } : {}
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

function remote(id: string, config: Record<string, unknown>): Provider {
  return new RemoteProvider({ id, ...remoteConfig(config), hints: runnerHints })
}

/** La entrada `remote`, con sus `${VAR}` resueltos del ambiente: el token es un secreto y
 *  `runner.yaml` sólo lo nombra. */
function remoteConfig(config: Record<string, unknown>): RemoteProviderConfig {
  const { type: _type, ...rest } = config
  const resolved = Object.fromEntries(
    Object.entries(rest).map(([key, value]) => [
      key,
      typeof value === 'string' ? fromEnv(value) : value,
    ]),
  )
  return parseRemoteProviderConfig(resolved)
}

function fromEnv(value: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => {
    const found = process.env[name]?.trim()
    if (!found) throw new Error(`falta ${name} en el ambiente`)
    return found
  })
}
