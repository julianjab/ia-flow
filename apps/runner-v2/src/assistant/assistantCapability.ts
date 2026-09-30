/**
 * El contrato del asistente de la web como capacidad del engine: quién la cumple es un agente de
 * la fuente global (`sources.capabilities.assistant` en runner.yaml → `.config/agents/assistant.yaml`),
 * editable como cualquier otro. Sin nadie enchufado, el asistente está apagado.
 */
import { defineCapability } from '@ia-flow/agent-engine'
import { z } from 'zod'
import { SESSION_KEY } from './AssistantDesk.js'

export const ASSISTANT = defineCapability({
  name: 'assistant',
  description:
    'Contesta una pregunta de quien opera el runner sobre la bandeja, una tarea o la config, con las tools `assistant_*`, y propone acciones que la persona confirma. La respuesta completa va en `submit_done.result.answer`.',
  input: z.strictObject({
    /** El pedido: las tools del asistente encuentran por acá su contexto (`AssistantDesk`). */
    [SESSION_KEY]: z.string(),
    /** De qué es la conversación, en palabras (todo el runner, un proyecto, una tarea). */
    context: z.string(),
    /** Lo que se habló antes, o vacío. */
    history: z.string(),
    question: z.string(),
  }),
  output: z.strictObject({
    /** La respuesta que lee la persona, completa (markdown). Obligatoria: un `submit_done` sin ella
     *  lo rechaza la tool y el modelo tiene que volver a cerrar. */
    answer: z.string().trim().min(1),
    /** Las tareas de las que habla la respuesta (`owner/repo#n`), en el orden en que las nombra: la
     *  web las muestra como cards que abren la tarea. */
    tasks: z.array(z.string()).max(12).optional(),
  }),
})
