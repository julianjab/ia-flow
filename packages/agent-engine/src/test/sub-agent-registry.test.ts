import { describe, expect, it } from 'bun:test'
import {
  registerPendingTask,
  removePendingTask,
  resolvePendingTask,
  subKey,
  waitForFinish,
} from '../pending-tasks.js'

// Un sub-agente corre sobre la MISMA task que su padre y se registra bajo una
// clave propia para no pisarlo. Antes, un tool llamado DESDE el hijo resolvía
// la entrada del PADRE (runId distinto) y caía a rehidratación, que reconstruye
// una entrada SIN la config del hijo. Para `submit_output` eso era fatal: no
// veía su `outputFields`, y después el run del hijo fallaba por no haber
// entregado el contrato que sí declaraba.

const base = {
  task: { id: 'T1' },
  manager: {},
  broadcast: () => {},
  initialStatus: 'Build',
} as never

describe('resolvePendingTask con sub-agentes', () => {
  it('un tool del hijo resuelve la entrada del HIJO, no la del padre', async () => {
    registerPendingTask('T1', { ...(base as object), runId: 'padre', agentId: 'papa' } as never)
    registerPendingTask(subKey('T1', 'hijo'), {
      ...(base as object),
      runId: 'hijo',
      agentId: 'nene',
      outputFields: { brief: { type: 'string' } },
    } as never)

    const resolved = await resolvePendingTask('T1', 'hijo')
    expect(resolved?.entry.agentId).toBe('nene')
    expect(resolved?.entry.outputFields).toEqual({ brief: { type: 'string' } })

    removePendingTask('T1')
    removePendingTask(subKey('T1', 'hijo'))
  })

  it('sin hijo registrado sigue resolviendo al padre', async () => {
    registerPendingTask('T1', { ...(base as object), runId: 'padre', agentId: 'papa' } as never)
    const resolved = await resolvePendingTask('T1', 'padre')
    expect(resolved?.entry.agentId).toBe('papa')
    removePendingTask('T1')
  })

  it('la clave del hijo se deriva del par (task, run)', () => {
    expect(subKey('T1', 'r9')).toBe('T1#sub:r9')
  })
})

// En async la entrada la borra el tool de cierre, así que para cuando
// `Agent.run` sale de `waitForFinish` ya no hay de dónde leer la salida. Si no
// viajara en el `finish`, un agente de terminal con contrato declarado fallaría
// SIEMPRE — habiéndolo entregado.
describe('la salida estructurada sobrevive al cierre async', () => {
  it('viaja en el FinishResult', async () => {
    registerPendingTask('T2', {
      ...(base as object),
      runId: 'r1',
      structuredOutput: { brief: 'listo' },
    } as never)

    const finished = waitForFinish('T2')
    removePendingTask('T2', { finalizedByTool: true })

    expect((await finished)?.structuredOutput).toEqual({ brief: 'listo' })
  })

  it('sin salida entregada el finish no la inventa', async () => {
    registerPendingTask('T3', { ...(base as object), runId: 'r1' } as never)
    const finished = waitForFinish('T3')
    removePendingTask('T3', { finalizedByTool: true })
    expect((await finished)?.structuredOutput).toBeUndefined()
  })
})
