import type { ManagerConfig } from '@ia-flow/shared'
import type { IIssueManager, IssueItem } from '../../domain/ports/IIssueManager.js'
import type { IManagerFactory } from '../../domain/ports/IManagerFactory.js'
import { LocalIssueManager } from '../../issue-managers/local/local-issue-manager.js'

export class LocalManagerFactory implements IManagerFactory {
  canHandle(cfg: ManagerConfig): boolean {
    return cfg.type === 'local'
  }

  create(_cfg: ManagerConfig, _dispatch: (item: IssueItem) => Promise<void>): IIssueManager {
    return new LocalIssueManager() as unknown as IIssueManager
  }
}
