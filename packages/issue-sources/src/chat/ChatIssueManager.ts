import type { TaskComment } from '@ia-flow/shared'
import type {
  BroadcastFn,
  DispatchOutcome,
  Disposable,
  IIssueManager,
  IssueItem,
  TaskSource,
} from '../contract.js'
import type { ChatSessionSource } from './ChatSessionSource.js'

/**
 * `IIssueManager` del asistente de chat — a mano, NO producto de
 * `buildManagers()`/`projectRepo.list()`: el asistente no es un proyecto
 * (a pedido explícito, ver la discusión en el PR), así que no hay una fila
 * `Project` de la que salga. Se construye una vez en
 * `composition/container.ts` y se resuelve a mano en
 * `managerFor(CHAT_PROJECT_ID)` (`composition/actions.ts`), fuera del mapa
 * de managers por proyecto que arma el daemon.
 *
 * `start()` nunca se llama en la práctica — el daemon sólo invoca `start`
 * sobre los managers que él mismo registró, y éste vive deliberadamente
 * fuera de esa lista: sin scan periódico, sin webhook mode, sin catch-up.
 * El único disparador del asistente es el evento `chat.message` (ver
 * `apps/server/src/system-agents/`), que llega con el `IssueItem` ya
 * resuelto en el payload — no hace falta que nadie escanee nada.
 */
export class ChatIssueManager implements IIssueManager {
  constructor(
    readonly projectId: string,
    private source: ChatSessionSource,
    private broadcast: BroadcastFn,
  ) {}

  start(_dispatch: (item: IssueItem) => Promise<DispatchOutcome | undefined>): Disposable {
    return { dispose: () => {} }
  }

  getTransitionManager(item: IssueItem): TaskSource {
    return this.source.getTransitionManager(item, this.broadcast)
  }

  loadComments(item: IssueItem): Promise<TaskComment[]> {
    return this.source.loadComments(item)
  }
}
