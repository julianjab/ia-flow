/**
 * Qué puede tocar cada agente del body del issue. Se declara en `issueBody` del YAML:
 *
 *   issueBody:
 *     write: [prd]                                     → update_prd(<schema del PRD>)
 *     check: [prd.zona_de_impacto]                     → check_prd_zona_de_impacto({ items })
 *
 * Es de este proyecto: las secciones del body (el PRD) son su formato (`_lib/prd.ts`).
 *
 * El modelo nunca ve una tool genérica de "editar el body": ve exactamente lo que le toca. Un
 * agente que declara `update_issue_body` a secas sigue recibiendo esa tool (el body entero): es la
 * decisión explícita de darle todo.
 */

import { defineAction } from '@ia-flow/runner-v2/actions'
import type { Action } from '@ia-tools/agent-engine'
import type { GithubClient } from '@ia-tools/github-api'
import { CheckSectionItemsAction, IssueSectionAction } from '@ia-tools/github-tools'
import { z } from 'zod'
import { ISSUE_BODY_SECTIONS } from './_lib/prd.js'

export interface IssueBodyPermission {
  /** Bloques que el agente reescribe completos. */
  write: string[]
  /** Checklists (`<bloque>.<campo>`) en los que sólo puede tildar. */
  check: string[]
}

/** Las acciones concretas de un permiso. Un bloque o checklist que no existe falla acá, al montar. */
export function issueBodyActions(
  agentId: string,
  permission: IssueBodyPermission,
  client: GithubClient,
): Action[] {
  const sectionOf = (id: string) => {
    const section = ISSUE_BODY_SECTIONS[id]
    if (!section) {
      throw new Error(
        `agente "${agentId}": el bloque "${id}" no existe (hay: ${Object.keys(ISSUE_BODY_SECTIONS).join(', ')})`,
      )
    }
    return section
  }

  const writes = permission.write.map(
    (id) => new IssueSectionAction({ client, section: sectionOf(id).definition }),
  )
  const checks = permission.check.map((ref) => {
    const [sectionId, field] = ref.split(/\.(.*)/s) as [string, string | undefined]
    const title = field ? sectionOf(sectionId).checklists[field] : undefined
    if (!title) {
      throw new Error(
        `agente "${agentId}": "${ref}" no es un checklist tildable (hay: ${Object.entries(
          ISSUE_BODY_SECTIONS,
        )
          .flatMap(([id, s]) => Object.keys(s.checklists).map((f) => `${id}.${f}`))
          .join(', ')})`,
      )
    }
    return new CheckSectionItemsAction({ client, section: ref, title })
  })
  return [...writes, ...checks]
}

const IssueBodyOptions = z.strictObject({
  /** Bloques que el agente reescribe completos. */
  write: z.array(z.string()).default([]),
  /** Checklists (`<bloque>.<campo>`) en los que sólo puede tildar. */
  check: z.array(z.string()).default([]),
})

export default defineAction({
  id: 'issue_body',
  create: (ctx) => {
    if (!ctx.agentId) throw new Error('issue_body es de un agente')
    const parsed = IssueBodyOptions.safeParse(ctx.options)
    if (!parsed.success) {
      throw new Error(`issue_body: options inválidas\n${z.prettifyError(parsed.error)}`)
    }
    return issueBodyActions(ctx.agentId, parsed.data, ctx.services.github)
  },
})
