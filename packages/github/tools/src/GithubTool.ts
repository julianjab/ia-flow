import { SchemaTool, type ToolInputSchema } from '@ia-flow/agent-engine'
import type { GithubClient } from '@ia-flow/github-api'
import { type GithubIssueApiShape, issuePath, summarizeIssue } from './shared.js'

/**
 * Base de las 4 tools de GitHub — la herencia acá es sólo para lo COMPARTIDO entre ellas
 * (`this.client`, `this.issuePath(...)`, `this.summarizeIssue(...)`); `issuePath`/
 * `summarizeIssue` siguen viviendo como funciones puras en `shared.ts` (ahí las prueba
 * `shared.test.ts` directo, sin instanciar ninguna tool) — esta clase sólo las expone como
 * métodos protegidos para que una subclase no tenga que importarlas aparte. El input lo valida
 * `SchemaTool` contra el `input` (zod) de cada tool; `issuePath` sigue validando owner/repo
 * igual, porque es el único lugar que arma paths y no depende de que el caller haya validado.
 */
export abstract class GithubTool<S extends ToolInputSchema> extends SchemaTool<S> {
  constructor(protected readonly client: GithubClient) {
    super()
  }

  protected issuePath(owner: string, repo: string, number: number, suffix = ''): string {
    return issuePath(owner, repo, number, suffix)
  }

  protected summarizeIssue(issue: GithubIssueApiShape): string {
    return summarizeIssue(issue)
  }
}
