/**
 * Lo que las actions globales necesitan del proyecto de la fuente que las pide.
 */
import type { ActionContext, ProjectConfig } from '../defineAction.js'

/** El proyecto de la fuente que la pide: una action de proyecto no va en la fuente global. */
export function projectOf(ctx: ActionContext, action: string): ProjectConfig {
  if (!ctx.project) {
    throw new Error(
      `${action} trabaja sobre el board de un proyecto: no va en la fuente ${ctx.sourceId}`,
    )
  }
  return ctx.project
}

/** `owner/repo` de cada repo del catálogo del proyecto. */
export function repoRefs(project: ProjectConfig): string[] {
  return project.repos.map((repo) => `${repo.githubOwner}/${repo.githubRepo}`)
}

/** `{{project.repos}}` de los prompts: el catálogo del proyecto en texto. */
export function reposText(project: ProjectConfig): string {
  return project.repos
    .map(
      (repo) =>
        `- ${repo.name} (${repo.githubOwner}/${repo.githubRepo}): ${repo.description ?? ''}`,
    )
    .join('\n')
}
