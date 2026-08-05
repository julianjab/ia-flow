import type { IssueItem, ValidationResult } from './types.js'
import type { TransitionManager } from './transition-manager.js'

export interface Disposable {
  dispose(): void
}

export abstract class IssueManager {
  abstract start(dispatch: (item: IssueItem) => Promise<void>): Disposable
  abstract getTransitionManager(item: IssueItem): TransitionManager
  validate?(item: IssueItem): Promise<ValidationResult>
}
