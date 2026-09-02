// La conversación que el gate `whenText` de una regla todavía no vio — la
// versión de `renderConversationWindow` (@ia-flow/issue-sources) que puede
// correr ANTES de que cualquier agente despache.
//
// Reemplaza al `agent-text-gate.ts` que el refactor #122 dejó huérfano (ver
// el comentario de `AgentActivationSchema.whenText` en packages/shared):
// acá el `whenText` es de la REGLA, no del agente, así que no hay un único
// `agentId` candidato — se corta contra el primer paso `agent` del `do[]`
// (`firstAgentIdOf`, en `application/rule-classification.ts`). Una regla sin
// paso `agent` no tiene a quién cortarle la ventana.
//
// A diferencia de la versión vieja, ACÁ SÍ hay I/O: el `whenText` de agente
// corría después de que `TaskDispatcher` ya había cargado los comentarios
// para el dispatch; el `whenText` de regla corre ANTES de decidir si dispacha
// nada, así que cargar la conversación es una llamada nueva a la fuente. Es
// el motivo por el que este módulo es un `adapter/` (I/O) y no vive al lado
// de `renderConversationWindow`, que es pura.
import type { IIssueManager, IssueItem } from '@ia-flow/issue-sources'
import { renderConversationWindow } from '@ia-flow/issue-sources'
import type { EngineEvent, Rule } from '@ia-flow/shared'
import { firstAgentIdOf } from '../../application/rule-classification.js'
import { createLogger } from '../../logger.js'

const log = createLogger('rule-conversation')

export interface ResolveRuleConversationDeps {
  managerFor(projectId: string): IIssueManager | undefined
  resolveItem(projectId: string, scope: EngineEvent['scope']): Promise<IssueItem | undefined>
}

/**
 * `undefined` es el resultado normal, no una carencia: sin `projectId`, sin
 * ningún paso `agent` en la regla, sin manager para ese proyecto, sin item
 * resoluble, o sin comentarios nuevos, el `whenText` evalúa exactamente como
 * si esto no existiera — la conversación es una señal extra, nunca un
 * requisito.
 */
export function createResolveRuleConversation(deps: ResolveRuleConversationDeps) {
  return async function resolveRuleConversation(
    rule: Pick<Rule, 'id' | 'do'>,
    event: EngineEvent,
  ): Promise<string | undefined> {
    const projectId = event.scope.projectId
    if (!projectId) return undefined

    const agentId = firstAgentIdOf(rule)
    if (!agentId) return undefined

    const manager = deps.managerFor(projectId)
    if (!manager?.loadComments) return undefined

    try {
      const item = await deps.resolveItem(projectId, event.scope)
      if (!item) return undefined
      const comments = await manager.loadComments(item)
      return renderConversationWindow(comments, agentId) || undefined
    } catch (err) {
      // Best-effort, igual que `loadComments` en TaskDispatcher: un fallo acá
      // degrada el `whenText` a evaluar sin conversación, no aborta la regla.
      log.warn(
        { err: (err as Error).message, ruleId: rule.id, projectId },
        'no se pudo cargar la conversación — whenText evalúa sin ella',
      )
      return undefined
    }
  }
}
