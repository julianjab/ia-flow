import { defineCapability, type PipelineExecutionContext } from '@ia-flow/agent-engine'
import { z } from 'zod'
import type { GithubTaskReader } from './GithubTaskReader.js'

/**
 * El nombre de la rama de una task, como lo hacía ia-flow: `<feat|fix|chore|refactor|docs>/<slug>`
 * a partir del título, sin número ni id — la rama se vincula al issue por API (`link_branch`), no
 * por nombre. Lo propone quien cumpla esta capacidad (el agente `branch-namer`).
 */
export const BRANCH_NAME = defineCapability({
  name: 'branchName',
  description:
    'Propone el nombre de la rama git de una task: `<feat|fix|chore|refactor|docs>/<slug-en-kebab-case>`, sin número de issue.',
  input: z.strictObject({
    title: z.string(),
    description: z.string().describe('El body del issue, recortado.'),
    type: z.string().describe('`functional` o `technical`.'),
  }),
  output: z.strictObject({
    branch: z.string().min(1).describe('Sólo el nombre de la rama.'),
  }),
})

/** Un nombre de git ref válido: minúsculas, alfanuméricos, `/`, `-`, `_`, sin bordes raros, hasta
 *  80 caracteres. Vacío si no queda nada útil. */
export function sanitizeBranchName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/["'`]/g, '')
    .replace(/[^a-z0-9/_-]+/g, '-')
    .replace(/\/+/g, '/')
    .replace(/-+/g, '-')
    .replace(/\/-+|-+\//g, '/')
    .replace(/^[-/]+|[-/]+$/g, '')
    .slice(0, 80)
}

interface TaskRef {
  owner: string
  repo: string
  number: number
}

/**
 * La rama de cada task:
 *
 * - con `branchPrefix` en el proyecto: `<prefijo><número>`, siempre (se la encuentra por nombre);
 * - sin prefijo, como ia-flow: la rama vinculada al issue si ya tiene una; si no, la que propone
 *   la capacidad `branchName` (recordada por issue mientras el proceso vive: hasta que
 *   `link_branch` la vincula, cada evento de la task ve la misma); sin la capacidad, `task/<n>`.
 */
export class TaskBranches {
  /** Lo propuesto y todavía sin vincular, por task. Compartido entre instancias: el intake se
   *  rearma al recargar la definición y el nombre no tiene que cambiar por eso. */
  private static readonly proposed = new Map<string, string>()

  constructor(
    private readonly reader: GithubTaskReader,
    private readonly prefix: string | undefined,
  ) {}

  /** La rama que la task ya tiene (por prefijo, o vinculada al issue), si la tiene. */
  async known(task: TaskRef): Promise<string | undefined> {
    if (this.prefix) return `${this.prefix}${task.number}`
    const [linked] = await this.reader.linkedBranches(task.owner, task.repo, task.number)
    if (linked) TaskBranches.proposed.delete(key(task))
    return linked
  }

  /** Una rama nueva para una task que no tiene. */
  async propose(
    task: TaskRef,
    issue: { title: string; body?: string | null; type: string },
    ctx: PipelineExecutionContext,
  ): Promise<string> {
    const cached = TaskBranches.proposed.get(key(task))
    if (cached) return cached
    const fallback = `task/${task.number}`
    let branch = fallback
    try {
      const proposed = await ctx.capabilities?.invoke(BRANCH_NAME, {
        title: issue.title,
        description: (issue.body ?? '').slice(0, 500),
        type: issue.type,
      })
      branch = sanitizeBranchName(proposed?.branch ?? '') || fallback
    } catch {
      // Un nombre que no se pudo proponer no frena la task: queda el determinístico.
    }
    TaskBranches.proposed.set(key(task), branch)
    return branch
  }
}

function key({ owner, repo, number }: TaskRef): string {
  return `${owner}/${repo}#${number}`.toLowerCase()
}
