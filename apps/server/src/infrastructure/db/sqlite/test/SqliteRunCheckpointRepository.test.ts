import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import migration from '../../../../migrations/066-run-checkpoints.js'
import { SqliteRunCheckpointRepository } from '../SqliteRunCheckpointRepository.js'

let db: Database
let repo: SqliteRunCheckpointRepository

beforeEach(() => {
  db = new Database(':memory:')
  migration.up(db)
  repo = new SqliteRunCheckpointRepository(db)
})

describe('SqliteRunCheckpointRepository', () => {
  test('el segundo save del mismo run PISA al primero', async () => {
    await repo.save({ runId: 'r1', taskId: 't1', state: { messages: [{ role: 'user' }] } })
    await repo.save({
      runId: 'r1',
      taskId: 't1',
      state: { messages: [{ role: 'user' }, { role: 'assistant' }] },
    })

    const rows = db.query('SELECT * FROM run_checkpoints').all()
    expect(rows).toHaveLength(1)

    const found = await repo.getByTask('t1')
    expect((found?.state as { messages: unknown[] }).messages).toHaveLength(2)
  })

  test('`attempts` sólo cuenta en el INSERT — los saves siguientes no lo mueven', async () => {
    // El contador tiene que medir cuántas veces se REANUDÓ, no en qué vuelta
    // del loop murió el proceso. Si el upsert lo tocara, un run largo lo
    // inflaría solo y el tope cortaría reanudaciones legítimas.
    await repo.save({ runId: 'r2', taskId: 't1', state: { messages: [] }, attempts: 2 })
    await repo.save({ runId: 'r2', taskId: 't1', state: { messages: [{ role: 'user' }] } })
    await repo.save({ runId: 'r2', taskId: 't1', state: { messages: [{ role: 'x' }] } })

    expect((await repo.getByTask('t1'))?.attempts).toBe(2)
  })

  test('un run nuevo arranca en cero', async () => {
    await repo.save({ runId: 'r1', taskId: 't1', state: { messages: [] } })
    expect((await repo.getByTask('t1'))?.attempts).toBe(0)
  })

  test('getByTask devuelve el más reciente cuando quedó uno viejo sin limpiar', async () => {
    await repo.save({ runId: 'viejo', taskId: 't1', state: { messages: ['a'] } })
    // `updated_at` se genera adentro del repo, así que se fuerza para que las
    // dos filas no caigan en el mismo milisegundo.
    db.run("UPDATE run_checkpoints SET updated_at = '2020-01-01T00:00:00.000Z'")
    await repo.save({ runId: 'nuevo', taskId: 't1', state: { messages: ['b'] } })

    expect((await repo.getByTask('t1'))?.runId).toBe('nuevo')
  })

  test('delete saca la fila y getByTask deja de encontrarla', async () => {
    await repo.save({ runId: 'r1', taskId: 't1', state: { messages: [] } })
    await repo.delete('r1')

    expect(await repo.getByTask('t1')).toBeNull()
  })

  test('delete de un run que no existe no rompe', async () => {
    // Lo llama el `finally` del orquestador en todo run, incluidos los que
    // nunca llegaron a guardar nada (un provider de terminal, o un run que
    // falló antes del primer turno).
    await repo.delete('nunca-existio')
    expect(db.query('SELECT * FROM run_checkpoints').all()).toHaveLength(0)
  })
})
