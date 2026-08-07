import type { ManagerConfig } from '@ia-flow/shared'
import type { IIssueManager } from './IIssueManager.js'

export interface IManagerFactory {
  canHandle(config: ManagerConfig): boolean
  create(
    config: ManagerConfig,
    dispatch: (item: import('./IIssueManager.js').IssueItem) => Promise<void>,
  ): IIssueManager
}
