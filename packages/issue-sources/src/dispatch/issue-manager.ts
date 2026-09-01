import type {
  DispatchOutcome,
  Disposable,
  IssueItem,
  TaskSource,
  ValidationResult,
} from '../contract.js'

export type { Disposable }

export abstract class IssueManager {
  /** Ver IIssueManager.projectId — lo consume quien lo suscribe al bus. */
  abstract readonly projectId: string
  // `DispatchOutcome | void`: un manager que no le interesa la capacidad
  // puede seguir devolviendo void — sólo SourceDispatcher lee el resultado
  // (para volver a encolar un `deferred`, ver su dispatchNow).
  abstract start(dispatch: (item: IssueItem) => Promise<DispatchOutcome | undefined>): Disposable
  abstract getTransitionManager(item: IssueItem): TaskSource
  validate?(item: IssueItem): Promise<ValidationResult>
}
