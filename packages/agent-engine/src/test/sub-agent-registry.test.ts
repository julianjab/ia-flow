import { describe, expect, it } from 'bun:test'
import {
  registerPendingTask,
  removePendingTask,
  resolvePendingTask,
  subKey,
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
