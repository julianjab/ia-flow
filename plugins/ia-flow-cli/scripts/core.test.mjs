// Los tests viven sobre `core.mjs` y no sobre `flow.mjs` por una razón que es
// la misma que justifica el corte entre los dos archivos: acá está todo lo que
// DECIDE algo, y decide sin I/O. Lo de `flow.mjs` es `gh` y un spawn.
import { describe, expect, test } from 'bun:test'
import {
  ConfigError,
  StatusLabels,
  applyPatch,
  buildComment,
  buildContext,
  candidates,
  evalWhen,
  exitsBlock,
  explainNoMatch,
  formatComments,
  hasScope,
  isTracked,
  normalizeConfig,
  parseExitMarker,
  parseLabelOps,
  parseSet,
  parseYaml,
  renderTemplate,
  resolveCommentTarget,
  resolveExit,
  selectAgent,
  selectableExits,
} from './core.mjs'

// ─── YAML ────────────────────────────────────────────────────────────────

describe('parseYaml', () => {
  test('mapas anidados y escalares tipados', () => {
    expect(parseYaml('a:\n  b: 1\n  c: true\n  d: ~\n  e: hola')).toEqual({
      a: { b: 1, c: true, d: null, e: 'hola' },
    })
  })

  test('secuencia de mapas — el item arranca en la línea del guion', () => {
    expect(parseYaml('xs:\n  - id: a\n    n: 1\n  - id: b\n    n: 2')).toEqual({
      xs: [
        { id: 'a', n: 1 },
        { id: 'b', n: 2 },
      ],
    })
  })

  test('block scalar `|` conserva los saltos y la indentación relativa', () => {
    expect(parseYaml('p: |\n  uno\n    dos\n  tres').p).toBe('uno\n  dos\ntres\n')
  })

  test('`|-` no deja el salto final', () => {
    expect(parseYaml('p: |-\n  uno\n  dos').p).toBe('uno\ndos')
  })

  test('`>-` pliega las líneas contiguas con espacio', () => {
    expect(parseYaml('p: >-\n  uno\n  dos\n\n  tres').p).toBe('uno dos\ntres')
  })

  test('flow inline: listas y mapas', () => {
    expect(parseYaml('a: [x, y]\nb: { c: 1, d: dos }')).toEqual({
      a: ['x', 'y'],
      b: { c: 1, d: 'dos' },
    })
  })

  test('los comentarios se ignoran, adentro de comillas no', () => {
    expect(parseYaml('# arriba\na: 1  # al costado\nb: "no # es comentario"')).toEqual({
      a: 1,
      b: 'no # es comentario',
    })
  })

  test('un `:` adentro de comillas no parte la clave', () => {
    expect(parseYaml('a: "x: y"')).toEqual({ a: 'x: y' })
  })

  test('una clave sin hijo es null, no un objeto vacío', () => {
    // Vacío significa "sin restricción" en la activación; `{}` no lo diría.
    expect(parseYaml('a:\nb: 1')).toEqual({ a: null, b: 1 })
  })

  test('un prefijo con `:` sobrevive como valor', () => {
    expect(parseYaml('statusPrefix: "status:"').statusPrefix).toBe('status:')
  })
})

// ─── Labels ──────────────────────────────────────────────────────────────

describe('StatusLabels', () => {
  const labels = new StatusLabels()

  test('deriva el status del prefijo, y vacío cuando no hay', () => {
    expect(labels.statusFrom(['ia-flow', 'status:refine'])).toBe('refine')
    expect(labels.statusFrom(['ia-flow'])).toBe('')
  })

  test('un status a la vez — el nuevo reemplaza al viejo', () => {
    expect(labels.withStatus(['ia-flow', 'status:refine'], 'build')).toEqual([
      'ia-flow',
      'status:build',
    ])
  })

  test('un status vacío saca la label sin poner otra', () => {
    expect(labels.withStatus(['ia-flow', 'status:refine'], '')).toEqual(['ia-flow'])
  })

  test('el prefijo se compara sin distinguir mayúsculas', () => {
    expect(new StatusLabels({ prefix: 'Status:' }).statusFrom(['STATUS:build'])).toBe('build')
  })

  test('withWorking es idempotente en las dos direcciones', () => {
    const on = labels.withWorking(['ia-flow'], true)
    expect(labels.withWorking(on, true)).toEqual(on)
    expect(labels.withWorking(labels.withWorking(on, false), false)).toEqual(['ia-flow'])
  })

  test('isTracked es el opt-in del pipeline', () => {
    expect(isTracked(['ia-flow', 'bug'], 'ia-flow')).toBe(true)
    expect(isTracked(['bug'], 'ia-flow')).toBe(false)
    expect(isTracked(['bug'], '')).toBe(true)
  })
})

// ─── Selección ───────────────────────────────────────────────────────────

const agent = (id, activation, extra = {}) => ({ id, activation, ...extra })
const issue = (over = {}) => ({ number: 1, status: 'refine', labels: [], repo: 'r', ...over })

describe('selección de agente', () => {
  test('filtra por status', () => {
    const roster = [agent('a', { statusName: 'refine' }), agent('b', { statusName: 'build' })]
    expect(selectAgent(roster, issue()).id).toBe('a')
    expect(selectAgent(roster, issue({ status: 'build' })).id).toBe('b')
  })

  test('gana el menor position', () => {
    const roster = [
      agent('tarde', { statusName: 'refine', position: 5 }),
      agent('temprano', { statusName: 'refine', position: 1 }),
    ]
    expect(selectAgent(roster, issue()).id).toBe('temprano')
  })

  test('repoName vacío es "sin restricción"', () => {
    expect(selectAgent([agent('a', { statusName: 'refine' })], issue({ repo: 'otro' })).id).toBe(
      'a',
    )
    expect(selectAgent([agent('a', { statusName: 'refine', repoName: 'x' })], issue())).toBeNull()
  })

  test('un agente sin scope no es candidato — es el freno del loop', () => {
    // Sin statusName ni when, su propia salida no lo sacaría de la selección.
    expect(hasScope(agent('a', {}))).toBe(false)
    expect(selectAgent([agent('a', {})], issue())).toBeNull()
  })

  test('enabled: false lo saca', () => {
    expect(
      selectAgent([agent('a', { statusName: 'refine' }, { enabled: false })], issue()),
    ).toBeNull()
  })

  test('explainNoMatch dice por qué no corrió ninguno', () => {
    const reasons = explainNoMatch([agent('a', { statusName: 'build' }), agent('b', {})], issue())
    expect(reasons[0]).toContain("status 'build'")
    expect(reasons[1]).toContain('sin scope')
  })

  test('candidates devuelve todos los que sobreviven, ordenados', () => {
    const roster = [
      agent('b', { statusName: 'refine', position: 2 }),
      agent('a', { statusName: 'refine', position: 1 }),
    ]
    expect(candidates(roster, issue()).map((a) => a.id)).toEqual(['a', 'b'])
  })
})

describe('evalWhen', () => {
  test('ausente matchea siempre', () => {
    expect(evalWhen(undefined, issue())).toBe(true)
  })

  test('el record plano es todo-igualdad', () => {
    expect(evalWhen({ status: 'refine' }, issue())).toBe(true)
    expect(evalWhen({ status: 'build' }, issue())).toBe(false)
  })

  test('contains sobre un array busca por elemento, no por substring', () => {
    const it = issue({ labels: ['bug', 'p1'] })
    expect(evalWhen([{ field: 'labels', op: 'contains', value: 'bug' }], it)).toBe(true)
    expect(evalWhen([{ field: 'labels', op: 'contains', value: 'bu' }], it)).toBe(false)
  })

  test('las condiciones de un array son AND', () => {
    const it = issue({ labels: ['bug'] })
    expect(
      evalWhen(
        [
          { field: 'status', op: '=', value: 'refine' },
          { field: 'labels', op: 'contains', value: 'nope' },
        ],
        it,
      ),
    ).toBe(false)
  })

  test('in, matches y empty', () => {
    const it = issue({ title: 'Crash al guardar', body: '' })
    expect(evalWhen([{ field: 'status', op: 'in', value: 'refine, build' }], it)).toBe(true)
    expect(evalWhen([{ field: 'title', op: 'matches', value: '^crash' }], it)).toBe(true)
    expect(evalWhen([{ field: 'body', op: 'empty' }], it)).toBe(true)
  })

  test('un operador desconocido tira en vez de matchear en silencio', () => {
    expect(() => evalWhen([{ field: 'status', op: 'wat', value: 'x' }], issue())).toThrow(/wat/)
  })
})

// ─── Transiciones ────────────────────────────────────────────────────────

describe('parseSet', () => {
  test('un nombre pelado es el status', () => {
    expect(parseSet('build')).toEqual({ status: 'build' })
  })

  test('acepta el prefijo $set: del engine', () => {
    expect(parseSet('$set:status=build')).toEqual({ status: 'build' })
  })

  test('varios campos separados por ;', () => {
    expect(parseSet('status=done; state=closed')).toEqual({ status: 'done', state: 'closed' })
  })

  test('las labels llevan signo; sin signo es agregar', () => {
    expect(parseLabelOps('+a,-b,c')).toEqual({ add: ['a', 'c'], remove: ['b'] })
  })

  test('un campo desconocido tira', () => {
    expect(() => parseSet('prioridad=alta')).toThrow(/prioridad/)
  })

  test('vacío es "no aplicar ninguna transición"', () => {
    expect(parseSet('')).toBeNull()
    expect(parseSet(undefined)).toBeNull()
  })
})

describe('applyPatch', () => {
  const labels = new StatusLabels()

  test('mueve el status conservando el resto', () => {
    const next = applyPatch(['ia-flow', 'bug', 'status:refine'], parseSet('build'), labels)
    expect(next).toEqual(['ia-flow', 'bug', 'status:build'])
  })

  test('suma y resta labels', () => {
    const next = applyPatch(['ia-flow', 'wip'], parseSet('labels=+needs-qa,-wip'), labels)
    expect(next).toEqual(['ia-flow', 'needs-qa'])
  })

  test('no duplica una label que ya está', () => {
    expect(applyPatch(['ia-flow'], parseSet('labels=ia-flow'), labels)).toEqual(['ia-flow'])
  })

  test('una label agregada por un humano durante el run sobrevive', () => {
    // El delta se resuelve contra las labels FRESCAS, no contra las del scan.
    const fresh = ['ia-flow', 'status:refine', 'urgente']
    expect(applyPatch(fresh, parseSet('build'), labels)).toContain('urgente')
  })
})

describe('salidas', () => {
  const refiner = {
    id: 'refiner',
    comment: 'issue',
    exits: {
      success: 'build',
      error: 'blocked',
      'needs-info': { set: 'status=needs-info', when: 'falta el repro', comment: 'pr' },
    },
  }

  test('selectableExits excluye las dos reservadas', () => {
    expect(selectableExits(refiner).map((e) => e.name)).toEqual(['needs-info'])
  })

  test('el destino del comentario se resuelve salida > agente > default', () => {
    expect(resolveCommentTarget(refiner.exits['needs-info'], refiner.comment)).toBe('pr')
    expect(resolveCommentTarget(refiner.exits.success, refiner.comment)).toBe('issue')
    expect(resolveCommentTarget(undefined, undefined)).toBe('pr-else-issue')
  })

  test('exitsBlock explica sólo las elegibles, y es vacío si no hay', () => {
    expect(exitsBlock(refiner)).toContain('needs-info')
    expect(exitsBlock(refiner)).toContain('falta el repro')
    expect(exitsBlock({ exits: { success: 'build' } })).toBe('')
  })
})

// ─── Salida del run ──────────────────────────────────────────────────────

describe('parseExitMarker', () => {
  test('lee el bloque', () => {
    const text = 'listo\n<ia-flow:exit>\n{"exit":"needs-info","summary":"falta"}\n</ia-flow:exit>'
    expect(parseExitMarker(text)).toEqual({ exit: 'needs-info', summary: 'falta' })
  })

  test('gana el último — un modelo puede mostrar el formato antes de usarlo', () => {
    const text =
      '<ia-flow:exit>{"exit":"a"}</ia-flow:exit> luego <ia-flow:exit>{"exit":"b"}</ia-flow:exit>'
    expect(parseExitMarker(text).exit).toBe('b')
  })

  test('acepta el nombre pelado adentro del bloque', () => {
    expect(parseExitMarker('<ia-flow:exit>build</ia-flow:exit>').exit).toBe('build')
  })

  test('tolera el bloque envuelto en un fence', () => {
    expect(
      parseExitMarker('<ia-flow:exit>\n```json\n{"exit":"x"}\n```\n</ia-flow:exit>').exit,
    ).toBe('x')
  })

  test('sin bloque, null', () => {
    expect(parseExitMarker('nada que ver')).toBeNull()
    expect(parseExitMarker('')).toBeNull()
  })
})

describe('resolveExit', () => {
  const a = { exits: { success: 'build', error: 'blocked', 'needs-info': { set: 'x', when: 'y' } } }

  test('sin pedido, manda cómo terminó el proceso', () => {
    expect(resolveExit(a, null, true).name).toBe('success')
    expect(resolveExit(a, null, false).name).toBe('error')
  })

  test('un pedido válido gana', () => {
    expect(resolveExit(a, 'needs-info', true).name).toBe('needs-info')
  })

  test('una salida no declarada cae al default y explica por qué', () => {
    const r = resolveExit(a, 'inventada', true)
    expect(r.name).toBe('success')
    expect(r.reason).toContain('inventada')
  })
})

// ─── Config ──────────────────────────────────────────────────────────────

const validAgent = {
  id: 'refiner',
  prompt: 'hacé algo',
  activation: { statusName: 'refine' },
  exits: { success: 'build' },
}

describe('normalizeConfig', () => {
  test('aplica los defaults de settings', () => {
    const cfg = normalizeConfig({ agents: [validAgent] })
    expect(cfg.settings.anchorLabel).toBe('ia-flow')
    expect(cfg.settings.statusPrefix).toBe('status:')
    expect(cfg.settings.exec).toBe('claude')
  })

  test('rechaza un agente sin scope, nombrando el loop que evita', () => {
    const bad = { ...validAgent, activation: {} }
    expect(() => normalizeConfig({ agents: [bad] })).toThrow(/sin scope/)
  })

  test('rechaza un id repetido', () => {
    expect(() => normalizeConfig({ agents: [validAgent, { ...validAgent }] })).toThrow(/repetido/)
  })

  test('rechaza un comment fuera del enum', () => {
    expect(() => normalizeConfig({ agents: [{ ...validAgent, comment: 'prs' }] })).toThrow(/prs/)
  })

  test('rechaza una transición con un campo desconocido', () => {
    const bad = { ...validAgent, exits: { success: 'prioridad=alta' } }
    expect(() => normalizeConfig({ agents: [bad] })).toThrow(/prioridad/)
  })

  test('rechaza una salida elegible sin `when`', () => {
    const bad = { ...validAgent, exits: { success: 'build', otra: 'x' } }
    expect(() => normalizeConfig({ agents: [bad] })).toThrow(/sin 'when'/)
  })

  test('junta TODOS los problemas en un error, no el primero', () => {
    try {
      normalizeConfig({ agents: [{ id: 'a', activation: {} }] })
      throw new Error('debió tirar')
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError)
      expect(err.problems.length).toBeGreaterThan(1)
    }
  })

  test('rechaza un roster vacío', () => {
    expect(() => normalizeConfig({ agents: [] })).toThrow(/al menos un agente/)
  })

  test('valida las condiciones de when', () => {
    const bad = { ...validAgent, activation: { when: [{ op: 'wat' }] } }
    expect(() => normalizeConfig({ agents: [bad] })).toThrow(/wat/)
  })
})

// ─── Render ──────────────────────────────────────────────────────────────

describe('renderTemplate', () => {
  const ctx = buildContext({
    issue: {
      number: 42,
      title: 'Crash',
      body: 'pasa siempre',
      status: 'refine',
      labels: ['bug'],
      comments: [{ author: 'ana', body: 'no pasa en dev', createdAt: '2026-01-02T10:00:00Z' }],
    },
    agent: { id: 'refiner', exits: { success: 'build' } },
    repo: { name: 'ia-flow', owner: 'julianjab' },
  })

  test('resuelve las variables de la task', () => {
    expect(renderTemplate('#{{task.number}} — {{task.title}}', ctx)).toBe('#42 — Crash')
  })

  test('rinde los comentarios con su fecha y autor', () => {
    expect(renderTemplate('{{task.comments}}', ctx)).toContain('[2026-01-02 · ana]')
  })

  test('una ruta desconocida queda literal', () => {
    // Un typo visible se diagnostica solo; reemplazarlo por vacío lo esconde.
    expect(renderTemplate('{{task.inventado}}', ctx)).toBe('{{task.inventado}}')
  })

  test('tolera espacios adentro de las llaves', () => {
    expect(renderTemplate('{{ agent.id }}', ctx)).toBe('refiner')
  })

  test('sin comentarios lo dice en vez de dejar un hueco', () => {
    expect(formatComments([])).toBe('(sin comentarios)')
  })
})

describe('buildComment', () => {
  test('lleva el marker de sistema y el header del agente', () => {
    const body = buildComment('refiner', '  el PRD  ')
    expect(body).toContain('<!-- ia-flow:cli -->')
    expect(body).toContain('# refiner')
    expect(body.endsWith('el PRD')).toBe(true)
  })
})
