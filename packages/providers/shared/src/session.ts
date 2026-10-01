import type { ProviderRunContext } from '@ia-flow/agent-engine'
import { captureContext, withInheritedAttributes } from '@ia-flow/telemetry'

/**
 * Lo que una sesión del CLI necesita de la corrida, igual si corre en esta máquina o en un host:
 * el prompt del turno, cómo se llama la sesión, qué tools la cierran y de qué span cuelga todo.
 */

/** La conversación de una corrida sobre el CLI: la sesión de Claude Code, que se retoma con
 *  `--resume` (tras esperar un evento, o tras un reinicio). */
export interface CliConversation {
  sessionId: string
}

/** La sesión a retomar, si la conversación guardada es de una sesión del CLI. */
export function cliSessionOf(value: unknown): string | undefined {
  const { sessionId } = (value ?? {}) as { sessionId?: unknown }
  return typeof sessionId === 'string' && sessionId ? sessionId : undefined
}

/** El prompt del turno: el del agente, o lo que pasó si se retoma una sesión que esperaba. */
export function turnPrompt(
  ctx: Pick<ProviderRunContext, 'prompt' | 'resume'>,
  resumed: boolean,
): string {
  return resumed && ctx.resume
    ? `[Continuación de tu turno]\n${ctx.resume.message}\n\nSeguí donde quedaste.`
    : ctx.prompt
}

/** Las tools que cierran el turno como una salida (no `fail_turn`). */
export function exitsOf(ctx: Pick<ProviderRunContext, 'tools'>): string[] {
  return ctx.tools.filter((tool) => tool.terminal && !tool.failure).map((tool) => tool.name)
}

/** `<agente>-task-<n>`: lo que ve un humano en `tmux ls`. */
export function labelOf(ctx: Pick<ProviderRunContext, 'agentId' | 'ctx'>): string {
  const number = (ctx.ctx.event.payload as { number?: unknown } | undefined)?.number
  return typeof number === 'number' ? `${ctx.agentId}-task-${number}` : ctx.agentId
}

/** El contexto del agente del que cuelga todo lo que llega por el canal, con `ia.execution.id`
 *  seguro (la pipeline ya lo hereda; un agente suelto con ejecución también lo lleva). */
export function runParent(ctx: Pick<ProviderRunContext, 'ctx'>) {
  const execution = ctx.ctx.execution
  return execution
    ? withInheritedAttributes({ 'ia.execution.id': execution.id }, captureContext)
    : captureContext()
}
