/**
 * Las ejecuciones en `bun:sqlite`: el mismo contrato que el store en memoria de
 * `@ia-flow/agent-engine`, y una pausa que sobrevive a cerrar y reabrir la base.
 */
import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventFilter, Pause } from '@ia-flow/agent-engine'
import { executionStoreContract } from '@ia-flow/agent-engine/testing'
import type { SqliteExecutionStore } from '@ia-flow/agent-engine-datasource-sqlite'
import { bunSqliteStoreDriver } from '../storage/bunSqliteStoreDriver.js'

executionStoreContract('bun-sqlite', (options) =>
  bunSqliteStoreDriver({ path: ':memory:', ...options }),
)

describe('bun-sqlite across a restart', () => {
  it('a paused execution is waiting again after reopening the database', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'runner-v2-db-')), 'state', 'executions.sqlite')
    const before = bunSqliteStoreDriver({ path }) as SqliteExecutionStore
    const execution = await before.start({ key: 'task', pipelineId: 'build-arrival' })
    const pause = new Pause('wait-ci', [
      { name: 'green', filter: new EventFilter({ on: ['check_suite'] }) },
    ])
    const checkpoint = {
      pipelineId: 'build-arrival',
      pauseId: 'wait-ci',
      resumeAt: 1,
      steps: {},
      shape: 'x',
    }
    await execution.run(async () => execution.pause(pause, checkpoint))
    before.close()

    const after = bunSqliteStoreDriver({ path }) as SqliteExecutionStore
    const restored = after.current('task')
    expect(restored?.id).toBe(execution.id)
    expect(restored?.pausedOn?.pauseId).toBe('wait-ci')
    expect(
      restored?.wake({ id: 'e1', type: 'check_suite', payload: {}, depth: 0, occurredAt: 'now' }),
    ).toEqual({
      branch: 'green',
      checkpoint,
    })
    after.close()
  })

  it('needs the path of the database', () => {
    expect(() => bunSqliteStoreDriver({})).toThrow(/necesita el archivo/)
  })
})
