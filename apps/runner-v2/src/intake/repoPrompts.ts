/**
 * Las notas de cada repo del catálogo (`prompt` en `repos/*.yaml`) para los agentes cuya task vive
 * en él: `{{task.repo_prompts}}` del payload, que el runner suma solo al final del prompt de cada
 * agente de un proyecto (ver `engine/withRepoPrompts.ts`). Puro, sin I/O.
 */

/** La variable del payload que lleva las notas, ya armadas. */
export const REPO_PROMPTS_VAR = 'task.repo_prompts'

/** Lo que el intake necesita de un repo del catálogo para sus notas. */
export interface RepoPromptEntry {
  name: string
  githubOwner?: string
  githubRepo?: string
  prompt?: string
}

const lower = (value: string) => value.toLowerCase()

/** Si `entry` es el repo `owner/repo` (sin mayúsculas, como GitHub). Un repo del catálogo sin
 *  `githubRepo` se reconoce por su `name`; sin `githubOwner`, vale cualquier owner. */
function isRepo(entry: RepoPromptEntry, owner: string, repo: string): boolean {
  const sameRepo = lower(entry.githubRepo ?? entry.name) === lower(repo)
  const sameOwner = entry.githubOwner === undefined || lower(entry.githubOwner) === lower(owner)
  return sameRepo && sameOwner
}

/**
 * Las notas de los repos de una task (`item.repos`), una sección por repo en el orden de `repos`:
 * `## Notas del repo \`<name>\`` y su `prompt`. Un repo sin `prompt` (o fuera del catálogo) no
 * agrega nada; ninguno, el texto vacío — así `{{task.repo_prompts}}` siempre resuelve.
 */
export function repoPromptsText(
  catalog: readonly RepoPromptEntry[] | undefined,
  owner: string,
  repos: readonly string[],
): string {
  return repos
    .flatMap((repo) => {
      const entry = catalog?.find((candidate) => isRepo(candidate, owner, repo))
      const notes = entry?.prompt?.trim()
      return entry && notes ? [`## Notas del repo \`${entry.name}\`\n\n${notes}`] : []
    })
    .join('\n\n')
}
