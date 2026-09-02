import type { AgentRunState, DispatchOptions } from '@ia-flow/agent-engine'
import type { IIssueManager, IssueItem } from '@ia-flow/issue-sources'
// Registro de las acciones que este daemon sabe ejecutar.
//
// Vive en `composition/` y no en el container mismo porque es cableado con
// forma de side effect (`registerAction` puebla un Map del paquete `rules`), y
// mezclarlo con las definiciones de repositorios haría más difícil ver qué se
// registra. Lo importa el arranque, una vez.
import { registerAction } from '@ia-flow/rules'
import { AgentAction } from '../adapters/actions/agent-action.js'
import { EmitAction } from '../adapters/actions/emit-action.js'
import { HttpAction } from '../adapters/actions/http-action.js'
import { createResolveEventItem } from '../adapters/actions/resolve-event-item.js'
import { createResolveRuleConversation } from '../adapters/actions/resolve-rule-conversation.js'
import { ScriptAction } from '../adapters/actions/script-action.js'
import { dispatcher, getSourceForProjectId, interpolateSecrets, repoRepo } from './container.js'

/** Los managers vivos, indexados por proyecto. Los publica `daemon.ts` en cada
 *  `startAll`/`reloadManagers`, porque su ciclo de vida es el del daemon y no
 *  el del container. */
const managers = new Map<string, IIssueManager>()

export function setActiveManagers(next: readonly IIssueManager[]): void {
  managers.clear()
  for (const m of next) managers.set(m.projectId, m)
}

/** Lookup del manager vivo de un proyecto — la misma tabla que usa `AgentAction`
 *  para despachar, expuesta para que otro consumidor (el gate `whenText` de
 *  `daemon.ts`) no tenga que mantener su propio índice. */
export function managerFor(projectId: string): IIssueManager | undefined {
  return managers.get(projectId)
}

/** De un scope de evento al issue del board — instancia única para que
 *  `AgentAction` y el gate `whenText` de `daemon.ts` resuelvan exactamente
 *  igual, sin duplicar el `sourceFor` que cablea. */
export const resolveEventItem = createResolveEventItem({ sourceFor: getSourceForProjectId })

/** La conversación que el gate `whenText` de una regla todavía no vio — ver
 *  `resolve-rule-conversation.ts` para el porqué de la I/O acá. */
export const resolveRuleConversation = createResolveRuleConversation({
  managerFor,
  resolveItem: resolveEventItem,
})

let registered = false

export function registerActions(): void {
  // Idempotente: los dos entrypoints (server y runner) lo llaman, y en tests
  // el módulo puede importarse más de una vez.
  if (registered) return
  registered = true

  registerAction(
    new AgentAction({
      managerFor: (projectId) => managers.get(projectId),
      // El agente lo elige la REGLA, no `selectAgent`: el dispatcher recibe el
      // id y saltea su propio gate de selección. Es lo que permite que un
      // `pr.opened` corra un agente sobre un issue cuyo status no matchearía
      // ninguna activación.
      dispatch: async (
        item: IssueItem,
        manager: IIssueManager,
        agentId: string,
        ruleId: string,
        event: { id: string; type: string; position: number },
        brief?: string,
        exits?: DispatchOptions['exits'],
      ) => {
        // El `state` es el canal de vuelta del run: `Agent.run` escribe ahí su
        // texto final y, si el agente declara contrato, la salida estructurada
        // que entregó por `submit_output`. Es el mismo mecanismo con el que
        // `runSubAgent` le devuelve el resultado a un agente padre.
        const state: AgentRunState = {}
        const outcome = await dispatcher.dispatch(item, manager, agentId, {
          ruleId,
          event,
          brief,
          exits,
          state,
        })
        return { outcome, output: state.structuredOutput ?? state.output }
      },
      // Los eventos de GitHub (`pr.*`, `ci.finished`) traen el PR, no el issue
      // del board. Sin esto una regla sobre cualquiera de ellos no dispara.
      resolveItem: resolveEventItem,
    }),
  )

  registerAction(new HttpAction({ resolveSecrets: interpolateSecrets }))
  registerAction(new EmitAction())

  // `script` se registra SIEMPRE: sus gates se evalúan por ejecución, no acá.
  // Registrarla condicionalmente haría que el editor no la ofrezca y que la
  // razón (falta el env, falta el token) sea invisible — el operador vería una
  // opción que no existe en vez de un motivo.
  registerAction(
    new ScriptAction({
      workspaceFor: async (event) => {
        const projectId = event.scope.projectId
        const repo = event.scope.repos?.[0]
        if (!projectId || !repo) return null
        return repoRepo.getByProject(repo, projectId)?.path ?? null
      },
    }),
  )
}
