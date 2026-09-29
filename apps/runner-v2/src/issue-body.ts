/**
 * Qué puede tocar cada agente del body del issue. Se declara en `issueBody` del YAML:
 *
 *   issueBody:
 *     write: [prd]                                     → update_prd(<schema del PRD>)
 *     check: [prd.zona_de_impacto]                     → check_prd_zona_de_impacto({ items })
 *
 * El modelo nunca ve una tool genérica de "editar el body": ve exactamente lo que le toca. Un
 * agente que declara `update_issue_body` a secas sigue recibiendo esa tool (el body entero): es la
 * decisión explícita de darle todo.
 */
import type { Action } from '@ia-tools/agent-engine'
import type { GithubClient } from '@ia-tools/github-api'
import { CheckSectionItemsAction, IssueSectionAction } from '@ia-tools/github-tools'
import { ISSUE_BODY_SECTIONS } from './prd.js'

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

/** La nota de runtime sobre las tools del body: cómo se comportan, más allá de su schema. */
export function issueBodyNote(permission: IssueBodyPermission, actions: Action[]): string {
  const names = actions.map((action) => `\`${action.id}\``).join(', ')
  const lines = [
    '## Cómo se escribe el body del issue en este runtime',
    '',
    `Tus tools sobre el body: ${names}.`,
  ]
  if (permission.write.length > 0) {
    lines.push(
      '',
      '- `update_<bloque>` recibe los CAMPOS del documento, no markdown: el formato (encabezados, tabla, checkboxes, classDef del diagrama) lo pone el runtime. Todo lo que el prompt describe en la plantilla va en el campo que corresponde.',
      '- Reescribe sólo su bloque: la descripción original del issue y cualquier otro bloque quedan intactos, así que no la copies adentro del PRD. Mandá el documento completo en cada llamada — los ítems ya tildados que no cambies de texto siguen tildados.',
    )
  }
  if (permission.check.length > 0) {
    lines.push(
      '',
      '- `check_<lista>` sólo tilda: `items` son los números de ítem contando desde 1 en el orden en que aparecen en esa lista del body. No podés reescribir el PRD; si un ítem está mal, decilo en tu reporte.',
      '- Si el issue no tiene el bloque (un PRD viejo, sin marcadores), la tool lo dice: seguí con el trabajo y reportá el progreso en el cierre.',
    )
  }
  return lines.join('\n')
}
