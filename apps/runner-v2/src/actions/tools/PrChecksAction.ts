import { Action, type PipelineExecutionContext } from '@ia-tools/agent-pipeline'
import type { GithubClient } from '@ia-tools/github-api'
import { z } from 'zod'
import { prFrom } from './pr-ref.js'

const NoInput = z.strictObject({})

/** Los checks del último commit del PR, con el título y el resumen que publica cada uno — para
 *  diagnosticar un rojo sin salir a buscar el log. */
export class PrChecksAction extends Action<typeof NoInput> {
  readonly description =
    'Lista los checks del último commit del PR (nombre, estado, conclusión, resumen y URL del detalle).'
  readonly input = NoInput
  override readonly sideEffects = 'none' as const

  constructor(private readonly client: GithubClient) {
    super({ id: 'pr_checks' })
  }

  async execute(_input: z.infer<typeof NoInput>, ctx: PipelineExecutionContext) {
    const pr = prFrom(ctx)
    const { check_runs } = await this.client.requestJson<{
      check_runs: Array<{
        name: string
        status: string
        conclusion: string | null
        details_url?: string
        output?: { title?: string | null; summary?: string | null }
      }>
    }>(`/repos/${pr.owner}/${pr.repo}/commits/${pr.sha}/check-runs?per_page=100`)
    if (check_runs.length === 0) return `El commit ${pr.sha.slice(0, 7)} no tiene checks.`
    return check_runs
      .map((run) => {
        const summary = run.output?.summary?.trim().slice(0, 800)
        return [
          `- **${run.name}**: ${run.status}${run.conclusion ? ` / ${run.conclusion}` : ''}`,
          run.output?.title ? `  ${run.output.title}` : '',
          summary ? `  ${summary.replaceAll('\n', '\n  ')}` : '',
          run.details_url ? `  ${run.details_url}` : '',
        ]
          .filter(Boolean)
          .join('\n')
      })
      .join('\n')
  }
}
