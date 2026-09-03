import { afterEach, describe, expect, it } from 'bun:test'
import { registerPendingTask, removePendingTask } from '@ia-flow/agent-engine'
import type { AgentOutput, Task } from '@ia-flow/shared'
import { getTool } from '../../engine.js'
import { validateOutput } from '../submit-output.js'
import '../submit-output.js'

// La validación es la razón de ser de esta tool: sin ella el paso siguiente
// recibe lo que el modelo haya querido escribir.

const fields: AgentOutput = {
  brief: { type: 'string', description: 'el encargo' },
  next: { type: 'string', enum: ['implementer', 'reviewer'] },
  score: { type: 'number', optional: true },
}

describe('validateOutput', () => {
  it('acepta un payload que cumple el contrato', () => {
    const r = validateOutput(fields, { brief: 'x', next: 'implementer' })
    expect(r).toEqual({ ok: true, value: { brief: 'x', next: 'implementer' } })
  })

  it('incluye los opcionales cuando vienen', () => {
    const r = validateOutput(fields, { brief: 'x', next: 'reviewer', score: 3 })
    expect(r.ok && r.value.score).toBe(3)
  })

  // Un contrato que se cumple a medias no sirve: el paso siguiente lo lee
  // creyendo que está completo.
  it('rechaza si falta un campo obligatorio', () => {
    const r = validateOutput(fields, { brief: 'x' })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.errors.join()).toContain("falta 'next'")
  })

  it('un opcional ausente no es un error', () => {
    expect(validateOutput(fields, { brief: 'x', next: 'reviewer' }).ok).toBe(true)
  })

  it('rechaza un tipo equivocado', () => {
    const r = validateOutput(fields, { brief: 'x', next: 'reviewer', score: 'tres' })
    expect(!r.ok && r.errors.join()).toContain('number')
  })

  // Mismo patrón que `select_exit`: el operador declara el espacio, el modelo
  // elige adentro.
  it('rechaza un valor fuera del enum', () => {
    const r = validateOutput(fields, { brief: 'x', next: 'quien-sea' })
    expect(!r.ok && r.errors.join()).toContain('implementer, reviewer')
  })

  // Casi siempre es un typo del nombre de un campo declarado. Descartarlo en
  // silencio movería el error al paso siguiente, como un valor vacío.
  it('rechaza campos no declarados en vez de ignorarlos', () => {
    const r = validateOutput(fields, { brief: 'x', next: 'reviewer', brif: 'y' })
    expect(!r.ok && r.errors.join()).toContain('brif')
  })

  it('un string vacío cuenta como ausente', () => {
    const r = validateOutput(fields, { brief: '', next: 'reviewer' })
    expect(!r.ok && r.errors.join()).toContain("falta 'brief'")
  })

  it('acumula todos los errores para que el modelo corrija de una', () => {
    const r = validateOutput(fields, {})
    expect(!r.ok && r.errors).toHaveLength(2)
  })
})

// Regresión: `task_id` era obligatorio y le pedía al modelo copiar
// `{{task.id}}` a mano — en el run que motivó esto llegó sin interpolar y la
// tool rechazó con "No hay tarea activa con id '{{task.id}}'". Ahora es
// opcional y cae a `ctx.taskId`, el mismo canal que ya usa `workspace_reset`.
describe('submit_output — resolución de task_id', () => {
  const TASK_ID = 'submit-output-task-under-test'

  function register(outputFields: AgentOutput) {
    const task: Task = {
      id: TASK_ID,
      title: 'Sample',
      description: '',
      status: 'Queue',
      type: 'functional',
      repos: [],
      created_at: '2025-01-01T00:00:00Z',
    }
    registerPendingTask(TASK_ID, {
      task,
      manager: {} as never,
      broadcast: () => {},
      initialStatus: 'Queue',
      outputFields,
    })
  }

  afterEach(() => {
    removePendingTask(TASK_ID)
  })

  it('cae a ctx.taskId cuando el input no trae task_id', async () => {
    register({ brief: { type: 'string' } })
    const tool = getTool('submit_output')!
    const result = await tool.execute({ brief: 'del contexto' }, { repoPaths: {}, taskId: TASK_ID })
    expect(result).toContain('brief')
  })

  it('sin task_id en el input ni en ctx, rechaza en vez de adivinar', async () => {
    register({ brief: { type: 'string' } })
    const tool = getTool('submit_output')!
    await expect(tool.execute({ brief: 'x' }, { repoPaths: {} })).rejects.toThrow(
      "No hay tarea activa con id ''",
    )
  })
})
