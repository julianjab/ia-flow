import { Action, type PipelineExecutionContext } from '@ia-flow/agent-engine'
import type { GithubClient } from '@ia-flow/github-api'
import { z } from 'zod'
import { latestCheckRuns } from '../task/timeline.js'
import { prFrom } from './pr-ref.js'

const NoInput = z.strictObject({})

/** Cuántas anotaciones se listan por check: una página de la API (su máximo), y el resto se
 *  cuenta. Un Sonar con cientos de issues no tiene que comerse el contexto del agente. */
export const MAX_ANNOTATIONS_PER_CHECK = 50

interface CheckRun {
  id: number
  name: string
  status: string
  conclusion: string | null
  details_url?: string
  output?: { title?: string | null; summary?: string | null; annotations_count?: number }
}

interface Annotation {
  path: string
  start_line: number
  annotation_level: string
  title?: string | null
  message?: string | null
}

/** Una anotación en una línea: `nivel path:línea — regla`. La regla es el `title` (Sonar,
 *  reviewdog la ponen ahí); sin título, la primera línea con texto del mensaje. */
export function formatAnnotation(annotation: Annotation): string {
  const what =
    annotation.title?.trim() ||
    annotation.message
      ?.split('\n')
      .map((line) => line.trim())
      .find(Boolean) ||
    ''
  return `${annotation.annotation_level} ${annotation.path}:${annotation.start_line} — ${what}`
}

/** Los checks del último commit del PR, con el título, el resumen y las anotaciones que publica
 *  cada uno — para diagnosticar un rojo (o los issues de Sonar) sin salir a buscar el detalle. */
export class PrChecksAction extends Action<typeof NoInput> {
  readonly description =
    'Lista los checks del último commit del PR (nombre, estado, conclusión, resumen y URL del ' +
    'detalle) y, para los que las publican, sus anotaciones por `archivo:línea` con la regla: ' +
    'los issues nuevos de SonarCloud, los hallazgos de reviewdog/ESLint, los errores de un linter.'
  readonly input = NoInput
  override readonly sideEffects = 'none' as const

  constructor(private readonly client: GithubClient) {
    super({ id: 'pr_checks' })
  }

  async execute(_input: z.infer<typeof NoInput>, ctx: PipelineExecutionContext) {
    const pr = prFrom(ctx)
    const { check_runs: all } = await this.client.requestJson<{ check_runs: CheckRun[] }>(
      `/repos/${pr.owner}/${pr.repo}/commits/${pr.sha}/check-runs?per_page=100`,
    )
    // La última corrida de cada check, la que cuenta para el CI (`latestCheckRuns`).
    const check_runs = latestCheckRuns(all)
    if (check_runs.length === 0) return `El commit ${pr.sha.slice(0, 7)} no tiene checks.`
    const blocks = await Promise.all(
      check_runs.map(async (run) => {
        const summary = run.output?.summary?.trim().slice(0, 800)
        return [
          `- **${run.name}**: ${run.status}${run.conclusion ? ` / ${run.conclusion}` : ''}`,
          run.output?.title ? `  ${run.output.title}` : '',
          summary ? `  ${summary.replaceAll('\n', '\n  ')}` : '',
          run.details_url ? `  ${run.details_url}` : '',
          ...(await this.annotationLines(pr.owner, pr.repo, run)),
        ]
          .filter(Boolean)
          .join('\n')
      }),
    )
    return blocks.join('\n')
  }

  /** Las anotaciones de un check, ya formateadas e indentadas; nada si no tiene. Si la API
   *  falla, se dice en una línea: el resto de los checks sigue sirviendo. */
  private async annotationLines(owner: string, repo: string, run: CheckRun): Promise<string[]> {
    const count = run.output?.annotations_count ?? 0
    if (count <= 0) return []
    try {
      const annotations = await this.client.requestJson<Annotation[]>(
        `/repos/${owner}/${repo}/check-runs/${run.id}/annotations?per_page=${MAX_ANNOTATIONS_PER_CHECK}`,
      )
      const shown = annotations.slice(0, MAX_ANNOTATIONS_PER_CHECK)
      const rest = Math.max(count, annotations.length) - shown.length
      return [
        `  Anotaciones (${count}):`,
        ...shown.map((annotation) => `    - ${formatAnnotation(annotation)}`),
        rest > 0 ? `    … y ${rest} más (en el detalle del check)` : '',
      ]
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      return [`  Anotaciones (${count}): no se pudieron leer (${reason})`]
    }
  }
}
