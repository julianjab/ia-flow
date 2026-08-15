import type { Disposable, IssueItem, TaskSource, ValidationResult } from '../contract.js'

export type { Disposable }

export abstract class IssueManager {
  abstract start(dispatch: (item: IssueItem) => Promise<void>): Disposable
  abstract getTransitionManager(item: IssueItem): TaskSource
  validate?(item: IssueItem): Promise<ValidationResult>
}
