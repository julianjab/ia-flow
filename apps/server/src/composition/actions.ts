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
import { dispatcher, interpolateSecrets } from './container.js'

/** Los managers vivos, indexados por proyecto. Los publica `daemon.ts` en cada
 *  `startAll`/`reloadManagers`, porque su ciclo de vida es el del daemon y no
 *  el del container. */
const managers = new Map<string, IIssueManager>()

export function setActiveManagers(next: readonly IIssueManager[]): void {
  managers.clear()
  for (const m of next) managers.set(m.projectId, m)
}

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
      dispatch: (item: IssueItem, manager: IIssueManager, agentId: string, ruleId: string) =>
        dispatcher.dispatch(item, manager, agentId, ruleId),
    }),
  )

  registerAction(new HttpAction({ resolveSecrets: interpolateSecrets }))
  registerAction(new EmitAction())
}
