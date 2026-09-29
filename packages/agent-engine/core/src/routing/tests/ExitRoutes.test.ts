import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Action } from '../../pipeline/actions/Action.js'
import { FunctionAction } from '../../pipeline/actions/FunctionAction.js'
import {
  DONE_EXIT,
  END,
  type ExitRoutes,
  resolveRoutes,
  routeTargets,
  submitSchemaFor,
} from '../ExitRoutes.js'

const UpdateIssueInput = z.strictObject({
  status: z.string().optional(),
  labels: z.array(z.string()).optional(),
})

class UpdateIssue extends Action<typeof UpdateIssueInput> {
  readonly description = 'Actualiza el issue'
  readonly input = UpdateIssueInput
  constructor() {
    super({ id: 'update_issue' })
  }
  execute() {
    return null
  }
}

const PostCommentInput = z.strictObject({
  summary: z.string(),
  validations: z.array(z.string()),
  target: z.enum(['issue', 'pr']),
})

class PostComment extends Action<typeof PostCommentInput> {
  readonly description = 'Comenta'
  readonly input = PostCommentInput
  constructor() {
    super({ id: 'post_comment' })
  }
  execute() {
    return null
  }
}

const NotifyInput = z.strictObject({ summary: z.string() })

class Notify extends Action<typeof NotifyInput> {
  readonly description = 'Notifica'
  readonly input = NotifyInput
  constructor(id = 'notify') {
    super({ id })
  }
  execute() {
    return null
  }
}

const updateIssue = new UpdateIssue()
const toBuild = updateIssue.bind({ status: 'Build' })
const toRefined = updateIssue.bind({ status: 'Refined' })
const blocked = updateIssue.bind({ labels: ['blocked'] })
const commentOnIssue = new PostComment().bind({ target: 'issue' })
const commentOnPr = new PostComment().bind({ target: 'pr' })

const refiner: ExitRoutes = {
  routes: {
    done: { when: 'El PRD quedó listo', to: toRefined },
    back_to_build: { when: 'Falla la implementación', to: toBuild },
  },
  report: commentOnIssue,
}

describe('resolveRoutes', () => {
  it('uses the agent routes as-is when nothing overrides them', () => {
    const resolved = resolveRoutes('refiner', refiner)

    expect(resolved.exits.map((exit) => [exit.name, exit.origin])).toEqual([
      ['done', 'agent'],
      ['back_to_build', 'agent'],
    ])
    expect(resolved.exits[1]?.targets).toEqual([toBuild])
    expect(resolved.exits[1]?.when).toBe('Falla la implementación')
  })

  it('gives an agent without declared exits an implicit "done" that ends', () => {
    const resolved = resolveRoutes('chat', {})

    expect(resolved.exits).toEqual([
      {
        name: DONE_EXIT,
        when: undefined,
        targets: [],
        report: null,
        origin: 'agent',
        reportOrigin: null,
      },
    ])
  })

  it('a step override of `to` keeps the agent `when`', () => {
    const notify = new Notify()
    const resolved = resolveRoutes('refiner', refiner, {
      step: { routes: { done: { to: [toRefined, notify] } } },
    })

    const done = resolved.exits.find((exit) => exit.name === 'done')
    expect(done?.targets).toEqual([toRefined, notify])
    expect(done?.when).toBe('El PRD quedó listo')
    expect(done?.origin).toBe('step')
  })

  it('a step override with null removes the exit', () => {
    const resolved = resolveRoutes('refiner', refiner, {
      step: { routes: { back_to_build: null } },
    })

    expect(resolved.exits.map((exit) => exit.name)).toEqual(['done'])
  })

  it('rejects an override of an exit the agent does not declare', () => {
    expect(() =>
      resolveRoutes('refiner', refiner, { step: { routes: { redy: { to: END } } } }),
    ).toThrow(/sobrescribe "redy", que el agente no declara — declaradas: done, back_to_build/)
  })

  it('rejects removing every exit', () => {
    expect(() =>
      resolveRoutes('refiner', refiner, {
        step: { routes: { done: null, back_to_build: null } },
      }),
    ).toThrow(/eliminó todas sus salidas/)
  })

  it('rejects a vocabulary-only exit that nobody gave a destination', () => {
    const triage: ExitRoutes = {
      routes: { actionable: { when: 'Pide un cambio' }, not_actionable: { to: END } },
    }

    expect(() => resolveRoutes('triage', triage)).toThrow(
      /"actionable" no tiene destino — la pipeline tiene que ponérselo en routes.triage.routes.actionable.to/,
    )
  })

  it('accepts a vocabulary-only exit once the step gives it a destination', () => {
    const triage: ExitRoutes = {
      routes: { actionable: { when: 'Pide un cambio' }, not_actionable: { to: END } },
    }
    const notify = new Notify()

    const resolved = resolveRoutes('triage', triage, {
      step: { routes: { actionable: { to: notify } } },
    })

    expect(resolved.exits[0]).toMatchObject({
      name: 'actionable',
      when: 'Pide un cambio',
      targets: [notify],
    })
  })

  it('rejects null as an agent-level route', () => {
    expect(() => resolveRoutes('x', { routes: { done: null } })).toThrow(/sólo un paso elimina/)
  })

  it('rejects an exit name that cannot be part of a tool name', () => {
    expect(() => resolveRoutes('x', { routes: { 'a b': { to: END } } })).toThrow(
      /salida "a b" inválida/,
    )
  })

  describe('onInterrupt cascade (step > pipeline > agent > project)', () => {
    const projectInterrupt = { to: commentOnPr }
    const agentInterrupt = { to: commentOnIssue }

    it('the agent beats the project, and the step beats the agent', () => {
      const agent: ExitRoutes = { routes: { done: { to: END } }, onInterrupt: agentInterrupt }
      expect(
        resolveRoutes('x', agent, { project: { onInterrupt: projectInterrupt } }).onInterrupt,
      ).toEqual({ route: agentInterrupt, origin: 'agent' })
      expect(
        resolveRoutes('x', agent, { step: { onInterrupt: projectInterrupt } }).onInterrupt,
      ).toEqual({ route: projectInterrupt, origin: 'step' })
    })

    it('null cancels the levels below, and nobody defining it means none', () => {
      expect(
        resolveRoutes(
          'x',
          { routes: { done: { to: END } }, onInterrupt: null },
          { project: { onInterrupt: projectInterrupt } },
        ).onInterrupt,
      ).toBeNull()
      expect(resolveRoutes('x', { routes: { done: { to: END } } }).onInterrupt).toBeNull()
    })
  })

  describe('report and onError cascade (step > pipeline > agent > project)', () => {
    const projectError = { to: blocked }

    it('falls back to the project when nobody else defines them', () => {
      const resolved = resolveRoutes(
        'x',
        { routes: { done: { to: END } } },
        { project: { report: commentOnPr, onError: projectError } },
      )

      expect(resolved.report).toEqual({ target: commentOnPr, origin: 'project' })
      expect(resolved.onError).toEqual({ route: projectError, origin: 'project' })
      expect(resolved.exits[0]?.report).toBe(commentOnPr)
      expect(resolved.exits[0]?.reportOrigin).toBe('project')
    })

    it('the agent beats the project', () => {
      const resolved = resolveRoutes('refiner', refiner, { project: { report: commentOnPr } })

      expect(resolved.report).toEqual({ target: commentOnIssue, origin: 'agent' })
    })

    it('the pipeline beats the agent, and the step beats the pipeline', () => {
      const onPipeline = resolveRoutes('refiner', refiner, { pipeline: { report: commentOnPr } })
      const onStep = resolveRoutes('refiner', refiner, {
        pipeline: { report: commentOnPr },
        step: { report: commentOnIssue },
      })

      expect(onPipeline.report?.origin).toBe('pipeline')
      expect(onStep.report).toEqual({ target: commentOnIssue, origin: 'step' })
    })

    it('null at a level means "none", even if a more general level defines one', () => {
      const resolved = resolveRoutes(
        'triage',
        { routes: { done: { to: END } }, report: null, onError: null },
        { project: { report: commentOnPr, onError: projectError } },
      )

      expect(resolved.report).toBeNull()
      expect(resolved.onError).toBeNull()
      expect(resolved.exits[0]?.report).toBeNull()
    })

    it('an exit-level report beats every level, and exit-level null disables it', () => {
      const withExitReport = resolveRoutes('refiner', {
        ...refiner,
        routes: {
          done: { to: toRefined, report: commentOnPr },
          back_to_build: { to: toBuild, report: null },
        },
      })

      expect(withExitReport.exits[0]).toMatchObject({ report: commentOnPr, reportOrigin: 'exit' })
      expect(withExitReport.exits[1]).toMatchObject({ report: null, reportOrigin: null })
    })

    it('a step can override the report of a single exit', () => {
      const resolved = resolveRoutes('refiner', refiner, {
        step: { routes: { back_to_build: { report: commentOnPr } } },
      })

      expect(resolved.exits[1]).toMatchObject({
        targets: [toBuild],
        report: commentOnPr,
        reportOrigin: 'exit',
      })
    })
  })
})

describe('routeTargets', () => {
  it('normalizes to an array and drops END', () => {
    const notify = new Notify()

    expect(routeTargets(undefined)).toEqual([])
    expect(routeTargets(END)).toEqual([])
    expect(routeTargets(notify)).toEqual([notify])
    expect(routeTargets([notify, END])).toEqual([notify])
  })
})

describe('submitSchemaFor', () => {
  function exitOf(routes: ExitRoutes, name: string) {
    const exit = resolveRoutes('a', routes).exits.find((candidate) => candidate.name === name)
    if (!exit) throw new Error(`no exit ${name}`)
    return exit
  }

  it('asks for the report and for each destination input, keyed by id', () => {
    const exit = exitOf(
      { routes: { ready: { to: [toBuild, new Notify()] } }, report: commentOnIssue },
      'ready',
    )
    const schema = submitSchemaFor('a', exit)

    expect(Object.keys(schema.shape)).toEqual(['report', 'update_issue', 'notify'])
    expect(
      schema.safeParse({
        report: { summary: 's', validations: [] },
        notify: { summary: 'x' },
      }).success,
    ).toBe(true)
  })

  it('leaves out fields fixed by bind, and makes all-optional inputs optional', () => {
    const exit = exitOf({ routes: { done: { to: toBuild } } }, 'done')
    const schema = submitSchemaFor('a', exit)

    expect(schema.safeParse({}).success).toBe(true)
    expect(schema.safeParse({ update_issue: { status: 'Done' } }).success).toBe(false)
  })

  it('leaves out steps that take no input', () => {
    const emit = new FunctionAction({ id: 'emit', fn: () => null })
    const exit = exitOf({ routes: { done: { to: emit } } }, 'done')

    expect(Object.keys(submitSchemaFor('a', exit).shape)).toEqual([])
  })

  it('a destination whose input is fully bound disappears from the schema', () => {
    const exit = exitOf(
      { routes: { done: { to: updateIssue.bind({ status: 'Done', labels: [] }) } } },
      'done',
    )

    expect(Object.keys(submitSchemaFor('a', exit).shape)).toEqual([])
  })

  it('rejects two destinations under the same id', () => {
    const exit = exitOf({ routes: { done: { to: [new Notify(), new Notify()] } } }, 'done')

    expect(() => submitSchemaFor('a', exit)).toThrow(/dos pasos con input bajo la clave "notify"/)
  })

  it('rejects a destination that uses the reserved "report" id', () => {
    const exit = exitOf({ routes: { done: { to: new Notify('report') } } }, 'done')

    expect(() => submitSchemaFor('a', exit)).toThrow(/"report" está reservado/)
  })

  it('rejects the model inventing keys', () => {
    const exit = exitOf({ routes: { done: { to: new Notify() } } }, 'done')

    expect(
      submitSchemaFor('a', exit).safeParse({ notify: { summary: 'x' }, extra: 1 }).success,
    ).toBe(false)
  })
})
