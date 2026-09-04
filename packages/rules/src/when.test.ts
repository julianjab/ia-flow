import { describe, expect, test } from 'bun:test'
import { condToOp, evalWhen, evalWhenAll, traceWhen, traceWhenAll } from './when.js'

describe('evalWhen — comportamiento heredado', () => {
  test('sin condiciones matchea todo', () => {
    expect(evalWhen({ status: 'Ready' }, undefined)).toBe(true)
    expect(evalWhen({ status: 'Ready' }, [])).toBe(true)
  })

  test('el formato Record legacy es todo-AND', () => {
    const task = { status: 'Ready', type: 'functional' }
    expect(evalWhen(task, { status: 'Ready', type: 'functional' })).toBe(true)
    expect(evalWhen(task, { status: 'Ready', type: 'technical' })).toBe(false)
  })

  test('los grupos parten en cada logic=or: AND adentro, OR entre grupos', () => {
    const task = { status: 'Ready', type: 'technical' }
    expect(
      evalWhen(task, [
        { field: 'status', op: '=', value: 'Done' },
        { field: 'type', op: '=', value: 'technical', logic: 'or' },
      ]),
    ).toBe(true)
    expect(
      evalWhen(task, [
        { field: 'status', op: '=', value: 'Ready' },
        { field: 'type', op: '=', value: 'functional' },
      ]),
    ).toBe(false)
  })

  test('$null y $not_null tratan array vacío como vacío', () => {
    expect(evalWhen({ repos: [] }, [{ field: 'repos', op: '$null' }])).toBe(true)
    expect(evalWhen({ repos: ['api'] }, [{ field: 'repos', op: '$not_null' }])).toBe(true)
    expect(evalWhen({ branch: '' }, [{ field: 'branch', op: '$null' }])).toBe(true)
  })

  test('los arrays usan pertenencia, también para !=', () => {
    const task = { labels: ['bug', 'p1'] }
    expect(evalWhen(task, [{ field: 'labels', op: '=', value: 'bug' }])).toBe(true)
    expect(evalWhen(task, [{ field: 'labels', op: '!=', value: 'bug' }])).toBe(false)
    expect(evalWhen(task, [{ field: 'labels', op: '!=', value: 'wontfix' }])).toBe(true)
  })

  test('resuelve por alias y por fields', () => {
    const task = { repos: ['api'], fields: { Stage: 'qa' } }
    expect(evalWhen(task, [{ field: 'repository', op: '=', value: 'api' }])).toBe(true)
    expect(evalWhen(task, [{ field: 'Stage', op: '=', value: 'qa' }])).toBe(true)
    expect(evalWhen({ type: 'bug' }, [{ field: 'task type', op: '=', value: 'bug' }])).toBe(true)
  })
})

describe('evalWhen — paths anidados', () => {
  const event = { pr: { number: 42, isDraft: false, head: { ref: 'feat/x' } } }

  test('resuelve un camino con puntos sobre el payload', () => {
    expect(evalWhen(event, [{ field: 'pr.head.ref', op: '=', value: 'feat/x' }])).toBe(true)
    expect(evalWhen(event, [{ field: 'pr.head.ref', op: '=', value: 'main' }])).toBe(false)
  })

  test('un camino que no existe no explota', () => {
    expect(evalWhen(event, [{ field: 'pr.base.ref', op: '=', value: 'main' }])).toBe(false)
    expect(evalWhen(event, [{ field: 'a.b.c.d', op: '$null' }])).toBe(true)
  })

  test('la clave plana gana sobre el camino', () => {
    // Precedencia preservada: si alguien tiene una clave literal con punto,
    // sigue ganando sobre la resolución por camino.
    expect(evalWhen({ 'pr.number': '7', pr: { number: 42 } }, { 'pr.number': '7' })).toBe(true)
  })
})

describe('evalWhen — operadores nuevos', () => {
  test('comparación numérica', () => {
    const pr = { additions: 640 }
    expect(evalWhen(pr, [{ field: 'additions', op: '>', value: '500' }])).toBe(true)
    expect(evalWhen(pr, [{ field: 'additions', op: '<', value: '500' }])).toBe(false)
    expect(evalWhen(pr, [{ field: 'additions', op: '>=', value: '640' }])).toBe(true)
    expect(evalWhen(pr, [{ field: 'additions', op: '<=', value: '640' }])).toBe(true)
  })

  test('un valor no numérico no degrada a comparación de strings', () => {
    // '10' < '9' es true lexicográficamente — que es exactamente el resultado
    // sorprendente que este caso existe para prevenir.
    expect(evalWhen({ status: 'Ready' }, [{ field: 'status', op: '>', value: '5' }])).toBe(false)
    expect(evalWhen({ n: '10' }, [{ field: 'n', op: '>', value: '9' }])).toBe(true)
  })

  test('$contains es substring case-insensitive en strings', () => {
    const task = { title: 'Arreglar el login de Staging' }
    expect(evalWhen(task, [{ field: 'title', op: '$contains', value: 'login' }])).toBe(true)
    expect(evalWhen(task, [{ field: 'title', op: '$contains', value: 'STAGING' }])).toBe(true)
    expect(evalWhen(task, [{ field: 'title', op: '$contains', value: 'deploy' }])).toBe(false)
  })

  test('$contains es pertenencia en arrays', () => {
    expect(
      evalWhen({ labels: ['Bug'] }, [{ field: 'labels', op: '$contains', value: 'bug' }]),
    ).toBe(true)
  })

  test('$matches aplica una regex', () => {
    const task = { branch: 'feat/ABC-123' }
    expect(evalWhen(task, [{ field: 'branch', op: '$matches', value: '^feat/' }])).toBe(true)
    expect(evalWhen(task, [{ field: 'branch', op: '$matches', value: '^fix/' }])).toBe(false)
  })

  test('una regex inválida no matchea en vez de tirar', () => {
    expect(() =>
      evalWhen({ branch: 'x' }, [{ field: 'branch', op: '$matches', value: '([' }]),
    ).not.toThrow()
    expect(evalWhen({ branch: 'x' }, [{ field: 'branch', op: '$matches', value: '([' }])).toBe(
      false,
    )
  })

  test('el formato Record legacy acepta los mismos ops codificados', () => {
    expect(evalWhen({ additions: 640 }, { additions: '$gt:500' })).toBe(true)
    expect(evalWhen({ title: 'un Bug' }, { title: '$contains:bug' })).toBe(true)
  })
})

describe('condToOp', () => {
  test('codifica cada operador con su prefijo', () => {
    expect(condToOp({ op: '=', value: 'Ready' })).toBe('Ready')
    expect(condToOp({ op: '!=', value: 'Ready' })).toBe('$ne:Ready')
    expect(condToOp({ op: '>', value: '500' })).toBe('$gt:500')
    expect(condToOp({ op: '<=', value: '10' })).toBe('$lte:10')
    expect(condToOp({ op: '$contains', value: 'bug' })).toBe('$contains:bug')
    expect(condToOp({ op: '$matches', value: '^feat/' })).toBe('$matches:^feat/')
  })

  test('los operadores sin argumento pasan derecho', () => {
    expect(condToOp({ op: '$null' })).toBe('$null')
    expect(condToOp({ op: '$not_null' })).toBe('$not_null')
  })
})

describe('traceWhen', () => {
  test('matched es siempre igual al de evalWhen, para los mismos casos', () => {
    // Ambas funciones comparten toConditionGroups/evalCondition — este test
    // es la red que evita que se desincronicen si alguna cambia sola.
    const cases: Array<[Record<string, unknown>, unknown]> = [
      [{ status: 'Ready' }, undefined],
      [{ status: 'Ready' }, []],
      [
        { status: 'Ready', type: 'functional' },
        { status: 'Ready', type: 'functional' },
      ],
      [
        { status: 'Ready', type: 'functional' },
        { status: 'Ready', type: 'technical' },
      ],
      [
        { status: 'Ready', type: 'technical' },
        [
          { field: 'status', op: '=', value: 'Done' },
          { field: 'type', op: '=', value: 'technical', logic: 'or' },
        ],
      ],
      [{ labels: ['bug', 'p1'] }, [{ field: 'labels', op: '!=', value: 'bug' }]],
      [{}, [{ field: 'item.status', op: '=', value: 'Review' }]],
    ]

    for (const [subject, when] of cases) {
      expect(traceWhen(subject, when).matched).toBe(evalWhen(subject, when))
    }
  })

  test('sin condiciones, matched=true y groups vacío', () => {
    expect(traceWhen({ status: 'Ready' }, undefined)).toEqual({ matched: true, groups: [] })
    expect(traceWhen({ status: 'Ready' }, [])).toEqual({ matched: true, groups: [] })
  })

  test('el caso #1317: item.status contra un payload sin item', () => {
    // issues.unlabeled nunca trae `item` en su payload (ver
    // apps/server/src/adapters/github/webhook-events.ts#issuesEvent) — este
    // es el trace que hubiera mostrado la causa sin tener que leer el código.
    const trace = traceWhen({ action: 'unlabeled', issueNumber: 1317 }, [
      { field: 'item.status', op: '=', value: 'Review' },
    ])

    expect(trace).toEqual({
      matched: false,
      groups: [
        [{ field: 'item.status', op: '=', value: 'Review', actual: undefined, matched: false }],
      ],
    })
  })

  test('reporta cada condición del grupo AND que falló, no sólo la primera', () => {
    const trace = traceWhen({ status: 'Review' }, [
      { field: 'status', op: '=', value: 'Review' },
      { field: 'labels', op: '!=', value: 'blocked' },
    ])

    expect(trace.matched).toBe(true)
    expect(trace.groups[0]).toEqual([
      { field: 'status', op: '=', value: 'Review', actual: 'Review', matched: true },
      { field: 'labels', op: '!=', value: 'blocked', actual: undefined, matched: true },
    ])
  })

  test('en un OR, agrupa cada rama por separado', () => {
    const trace = traceWhen({ status: 'Ready', type: 'technical' }, [
      { field: 'status', op: '=', value: 'Done' },
      { field: 'type', op: '=', value: 'technical', logic: 'or' },
    ])

    expect(trace.matched).toBe(true)
    expect(trace.groups).toHaveLength(2)
    expect(trace.groups[0][0].matched).toBe(false)
    expect(trace.groups[1][0].matched).toBe(true)
  })
})

describe('evalWhenAll/traceWhenAll — merge de varias fuentes (baseWhen)', () => {
  test('sin ninguna fuente matchea todo', () => {
    expect(evalWhenAll({ status: 'Ready' })).toBe(true)
    expect(evalWhenAll({ status: 'Ready' }, undefined, [])).toBe(true)
  })

  test('una fuente vacía no restringe — sólo pesan las que traen condiciones', () => {
    const task = { labels: ['bug'] }
    expect(evalWhenAll(task, undefined, [{ field: 'labels', op: '!=', value: 'blocked' }])).toBe(
      true,
    )
    expect(evalWhenAll(task, [], { labels: '$ne:blocked' })).toBe(true)
  })

  test('ANDea el when de la regla con el baseWhen aunque ninguno solo alcance', () => {
    const task = { status: 'Ready', labels: ['bug'] }
    const ruleWhen = [{ field: 'status', op: '=', value: 'Ready' }]
    const baseWhen = [{ field: 'labels', op: '!=', value: 'blocked' }]
    expect(evalWhenAll(task, ruleWhen, baseWhen)).toBe(true)
    expect(evalWhenAll({ status: 'Ready', labels: ['blocked'] }, ruleWhen, baseWhen)).toBe(false)
  })

  test('cross-product: preserva el OR de cada fuente por separado', () => {
    // (status=Ready OR status=Done) AND (labels!=blocked)
    const ruleWhen = [
      { field: 'status', op: '=', value: 'Ready' },
      { field: 'status', op: '=', value: 'Done', logic: 'or' },
    ]
    const baseWhen = [{ field: 'labels', op: '!=', value: 'blocked' }]

    expect(evalWhenAll({ status: 'Ready', labels: ['bug'] }, ruleWhen, baseWhen)).toBe(true)
    expect(evalWhenAll({ status: 'Done', labels: ['bug'] }, ruleWhen, baseWhen)).toBe(true)
    expect(evalWhenAll({ status: 'Ready', labels: ['blocked'] }, ruleWhen, baseWhen)).toBe(false)
    expect(evalWhenAll({ status: 'Other', labels: ['bug'] }, ruleWhen, baseWhen)).toBe(false)
  })

  test('acepta varias fuentes base (p. ej. global + proyecto) combinadas', () => {
    const task = { labels: ['bug'], type: 'technical' }
    const globalBaseWhen = [{ field: 'labels', op: '!=', value: 'blocked' }]
    const projectBaseWhen = [{ field: 'type', op: '!=', value: 'spike' }]
    expect(evalWhenAll(task, undefined, globalBaseWhen, projectBaseWhen)).toBe(true)
    expect(
      evalWhenAll({ ...task, type: 'spike' }, undefined, globalBaseWhen, projectBaseWhen),
    ).toBe(false)
  })

  test('traceWhenAll reporta condiciones de todas las fuentes en el trace', () => {
    const trace = traceWhenAll(
      { status: 'Ready', labels: ['blocked'] },
      [{ field: 'status', op: '=', value: 'Ready' }],
      [{ field: 'labels', op: '!=', value: 'blocked' }],
    )
    expect(trace.matched).toBe(false)
    expect(trace.groups[0]).toEqual([
      { field: 'status', op: '=', value: 'Ready', actual: 'Ready', matched: true },
      { field: 'labels', op: '!=', value: 'blocked', actual: ['blocked'], matched: false },
    ])
  })
})
