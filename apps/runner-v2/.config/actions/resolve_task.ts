/**
 * `resolve_task`: el intake. De un webhook crudo de GitHub al evento de su task, en el proyecto que
 * le toca (ver `_lib/intake/ResolveTaskAction.ts`). Es global: decide de qué proyecto es el evento.
 */
import { defineAction } from '@ia-flow/runner-v2/actions'
import { GithubTaskReader } from './_lib/intake/GithubTaskReader.js'
import { ResolveTaskAction } from './_lib/intake/ResolveTaskAction.js'
import { repoRefs, reposText } from './_lib/project.js'

export default defineAction({
  id: 'resolve_task',
  create: (ctx) =>
    new ResolveTaskAction(
      () =>
        ctx.projects().map((project) => ({
          id: project.id,
          board: project.board,
          ...(project.branchPrefix ? { branchPrefix: project.branchPrefix } : {}),
          ...(project.label ? { label: project.label } : {}),
          repos: repoRefs(project),
          reposText: reposText(project),
        })),
      new GithubTaskReader(ctx.services.github),
    ),
})
