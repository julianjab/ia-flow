import type { ToolContext } from '../contract.js'
import { registerTool } from '../engine.js'
import { createLogger } from '../logger.js'

// `run_agent` — delegar en otro agente Y LEER LA RESPUESTA.
//
// Delegar *sin* esperar ya existía y no necesita una tool: el agente emite un
// evento y las reglas levantan a los hijos. Pero ahí no hay retorno — es un
// pipeline, no una jerarquía. Esta tool es el otro caso: el padre bloquea y el
// resultado del hijo vuelve como `tool_result`.
//
// El otro camino para lo mismo es `pause_for_message` + una regla que despierte
// con `run.finished`. Cuándo cada uno:
//
//   run_agent  → hijos de segundos a minutos. Retiene slot, lock y worktree
//                mientras espera, pero no re-paga el input del padre.
//   pausa      → hijos largos, o en otra máquina. Libera todo, pero al
//                despertar el padre rehidrata y vuelve a pagar su input.
//
// **El hijo NO hereda el contexto del padre.** Recibe la task, su propio
// prompt y sus propias tools; el brief se lo escribe el padre explícitamente en
// `brief`. Eso no es una carencia: el aislamiento de contexto es la razón de
// ser de un sub-agente. Su memoria también es suya — `memory_*` ya está
// namespaceado por `(agentId, projectId)`.

const log = createLogger('tool-run-agent')

export interface RunAgentPort {
  /**
   * Corre un agente del roster sobre la task en curso y espera su resultado.
   *
   * Lo implementa el composition root, que es el único que tiene el
   * orquestador. Devuelve el texto que produjo el hijo, o el motivo por el que
   * no se pudo correr.
   */
  runAgent(input: {
    taskId: string
    agentId: string
    brief: string
    /** Del padre, para el aislamiento de caps y el freno de profundidad. */
    parentRunId: string
    parentDepth: number
  }): Promise<{ ok: true; output: string } | { ok: false; reason: string }>
}

let port: RunAgentPort | null = null

export function setRunAgentPort(p: RunAgentPort | null): void {
  port = p
}

registerTool({
  name: 'run_agent',
  description:
    'Delegá una parte del trabajo en otro agente y esperá su respuesta. ' +
    'El agente hijo NO ve tu conversación: contale en `brief` todo lo que necesita saber. ' +
    'Usalo para trabajo acotado que otro agente hace mejor (correr y leer los tests, ' +
    'revisar un diff, investigar un archivo grande) y cuando necesites su resultado para seguir. ' +
    'Si no necesitás la respuesta, no uses esto: terminá y dejá que el pipeline siga.',
  input_schema: {
    type: 'object',
    properties: {
      agentId: {
        type: 'string',
        description: 'Id del agente del roster que va a hacer el trabajo.',
      },
      brief: {
        type: 'string',
        description:
          'Qué necesitás que haga, completo y auto-contenido. El hijo no ve tu ' +
          'conversación ni tu razonamiento — sólo esto y la tarea.',
      },
    },
    required: ['agentId', 'brief'],
  },
  // Sólo `sync`: en un provider de terminal el CLI ya trae su propio mecanismo
  // de sub-agentes, y esta tool despacharía en el proceso equivocado.
  providerKinds: ['sync'],
  async execute(input: unknown, ctx: ToolContext): Promise<string> {
    const { agentId, brief } = (input ?? {}) as { agentId?: string; brief?: string }
    if (!port) return 'La delegación en sub-agentes no está disponible en este proceso.'
    if (!agentId?.trim()) return 'Error: falta `agentId`.'
    if (!brief?.trim()) {
      return 'Error: falta `brief`. El hijo no ve tu conversación, así que sin brief no tiene con qué trabajar.'
    }

    const { taskId, runId } = ctx
    if (!taskId || !runId) {
      return 'Error: esta tool sólo funciona dentro de un run — no hay padre del cual colgar al hijo.'
    }
    // Delegarse a sí mismo es siempre un error de razonamiento, y el freno de
    // profundidad lo cortaría recién tres niveles más abajo. Acá es gratis.
    if (ctx.agentId && agentId.trim() === ctx.agentId) {
      return `Error: '${agentId}' sos vos. Delegá en otro agente, o hacé el trabajo vos mismo.`
    }

    log.info({ taskId, parentRunId: runId, child: agentId }, 'Delegando en un sub-agente')

    const result = await port.runAgent({
      taskId,
      agentId: agentId.trim(),
      brief: brief.trim(),
      parentRunId: runId,
      parentDepth: ctx.agentDepth ?? 0,
    })

    if (!result.ok) {
      // El motivo vuelve como texto y no como excepción: que un hijo no haya
      // podido correr es información que el padre puede usar (reintentar con
      // otro agente, seguir sin él), no un fallo del padre.
      log.warn({ taskId, child: agentId, reason: result.reason }, 'El sub-agente no corrió')
      return `El agente '${agentId}' no pudo correr: ${result.reason}`
    }

    return result.output
  },
})
