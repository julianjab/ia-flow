import type { Disposable, IssueItem, TransitionManager, ValidationResult } from '../contract.js'

export type { Disposable }

export abstract class IssueManager {
  abstract start(dispatch: (item: IssueItem) => Promise<void>): Disposable
  abstract getTransitionManager(item: IssueItem): TransitionManager
  validate?(item: IssueItem): Promise<ValidationResult>
}
