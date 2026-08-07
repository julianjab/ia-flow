import type { ManagerConfig } from '@ia-flow/shared'
import type { IBroadcast } from '../../domain/ports/IBroadcast.js'
import type { IIssueManager, IssueItem } from '../../domain/ports/IIssueManager.js'
import type { IManagerFactory } from '../../domain/ports/IManagerFactory.js'
import { GitHubIssueManager } from '../../issue-managers/github/github-issue-manager.js'

export class GitHubManagerFactory implements IManagerFactory {
  constructor(private broadcast: IBroadcast) {}

  canHandle(cfg: ManagerConfig): boolean {
    return cfg.type === 'github'
  }

  create(cfg: ManagerConfig, _dispatch: (item: IssueItem) => Promise<void>): IIssueManager {
    if (cfg.type !== 'github' || !cfg.url) {
      throw new Error('GitHubManagerFactory requires config.type === "github" and a url')
    }
    const broadcastFn = (msg: object) => this.broadcast.send(msg)
    return new GitHubIssueManager(cfg.url, broadcastFn) as unknown as IIssueManager
  }
}
