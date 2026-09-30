import { z } from 'zod'

/** `print`: `claude -p`, headless, dentro del proceso. `tmux`: una sesión interactiva en tmux, que
 *  un humano puede mirar (`tmux attach`) o traer al frente en iTerm (`surface`). */
export const ClaudeCliMode = z.enum(['print', 'tmux'])
export type ClaudeCliMode = z.infer<typeof ClaudeCliMode>

/**
 * Lo que un agente puede fijar en su `providerConfig` (y el provider tener de default, en
 * `runner.yaml`). Estricto: una clave de otro provider (ej. `maxTokens`) es un error al montar, no
 * config muerta.
 */
export const ClaudeCliConfig = z.strictObject({
  mode: ClaudeCliMode.optional(),
  /** `--model` (ej. `opus`, `claude-sonnet-5`). Sin esto, el default del CLI. */
  model: z.string().min(1).optional(),
  /** Flags extra del CLI, tal cual (ej. `["--effort", "high"]`). */
  args: z.array(z.string()).optional(),
  /** Variables de entorno de la sesión (van al `--settings`, no al shell). */
  env: z.record(z.string(), z.string()).optional(),
  /** Sólo `tmux`: abrir la sesión en una pestaña de iTerm (macOS). */
  surface: z.boolean().optional(),
  /** Cuánto puede durar una corrida antes de cortarla. Default: 120. */
  timeoutMinutes: z.number().int().positive().optional(),
  /** Cuántas veces se le insiste al modelo que cierre con `submit_*` cuando intenta terminar sin
   *  hacerlo. Default: 2. */
  maxStopNudges: z.number().int().min(0).optional(),
})
export type ClaudeCliConfig = z.infer<typeof ClaudeCliConfig>

/** Tira con el detalle si `raw` no es una config válida. */
export function parseClaudeCliConfig(raw: unknown): ClaudeCliConfig {
  const parsed = ClaudeCliConfig.safeParse(raw ?? {})
  if (!parsed.success) {
    throw new Error(`providerConfig de claude-cli inválido\n${z.prettifyError(parsed.error)}`)
  }
  return parsed.data
}

/** La del agente sobre la del provider, clave por clave (`env` y `args` se suman). */
export function mergeClaudeCliConfig(
  defaults: ClaudeCliConfig,
  agent: ClaudeCliConfig,
): ClaudeCliConfig {
  return {
    ...defaults,
    ...agent,
    env: { ...defaults.env, ...agent.env },
    args: [...(defaults.args ?? []), ...(agent.args ?? [])],
  }
}
