import { Condition, type ExitRoute, ParallelGroup } from '@ia-flow/agent-engine'
import { z } from 'zod'
import type { StepBuildContext, StepFactory } from '../StepFactory.js'
import { ConditionRows, RouteToNode, StepNode, WhenTextNode } from '../schema.js'

/** Una o varias salidas de los miembros. */
const Exits = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)])

const GroupRouteNode = z.strictObject({
  to: RouteToNode.optional(),
  /** El reporte de cierre del grupo para este veredicto. */
  report: StepNode.nullable().optional(),
})

const Node = z.strictObject({
  /** Los pasos que corren a la vez: agentes que no pausan. */
  parallel: z.array(StepNode).min(2),
  /** Obligatorio: `steps.<id>`, el span `group <id>` y `routes.<id>` en la pipeline. */
  id: z.string().min(1),
  /** Pasa si TODOS (`all`) o ALGUNO (`any`) de los miembros que corrieron eligió una de esas
   *  salidas. Una lista, porque los vocabularios difieren (`approved` del reviewer, `passed` del
   *  e2e). */
  until: z.union([z.strictObject({ all: Exits }), z.strictObject({ any: Exits })]),
  /** Ids de miembros CONSULTIVOS: corren y reportan, pero no votan ni hacen fallar al grupo. */
  advisory: z.array(z.string().min(1)).optional(),
  /** A dónde lleva cada veredicto. Sin `to`, termina ahí. */
  routes: z
    .strictObject({ passed: GroupRouteNode.optional(), failed: GroupRouteNode.optional() })
    .optional(),
  /** El reporte de cierre del grupo. Default: ninguno — cada miembro ya publica el suyo. */
  report: StepNode.nullable().optional(),
  when: ConditionRows.optional(),
  whenText: WhenTextNode.optional(),
  continueOnError: z.boolean().optional(),
})

const list = (exits: string | string[]) => (Array.isArray(exits) ? exits : [exits])

/**
 * `{ parallel: [{ agent: reviewer }, { agent: e2e-qa, when: [...] }], id: gate, until: { all:
 * [approved, passed] }, routes: { passed: { to: [...] }, failed: { to: [...] } } }`.
 *
 * El `onError` y el `onInterrupt` del grupo son los de la cascada (pipeline > proyecto).
 */
export class ParallelStepFactory implements StepFactory<z.infer<typeof Node>> {
  readonly keyword = 'parallel'
  readonly schema = Node

  create(node: z.infer<typeof Node>, context: StepBuildContext): ParallelGroup {
    const members = node.parallel.map((member, index) =>
      context.step(member, `${context.where}.parallel[${index}]`),
    )
    const route = (name: 'passed' | 'failed'): ExitRoute | undefined => {
      const declared = node.routes?.[name]
      if (!declared) return undefined
      const to = context.routeTo(declared.to, `${context.where}.routes.${name}.to`)
      return {
        ...(to !== undefined ? { to } : {}),
        ...(declared.report === null
          ? { report: null }
          : declared.report !== undefined
            ? { report: context.step(declared.report, `${context.where}.routes.${name}.report`) }
            : {}),
      }
    }
    const passed = route('passed')
    const failed = route('failed')
    return new ParallelGroup({
      id: node.id,
      members,
      until: 'all' in node.until ? { all: list(node.until.all) } : { any: list(node.until.any) },
      ...(node.advisory ? { advisory: node.advisory } : {}),
      routes: { ...(passed ? { passed } : {}), ...(failed ? { failed } : {}) },
      ...(node.report === null
        ? { report: null }
        : node.report !== undefined
          ? { report: context.step(node.report, `${context.where}.report`) }
          : {}),
      when: Condition.fromRows(node.when),
      ...context.whenText(node.whenText),
      ...(node.continueOnError !== undefined ? { continueOnError: node.continueOnError } : {}),
    })
  }
}
