import { rest } from './client.js'

/**
 * Reemplaza el set completo de labels del issue por `labels` (PUT).
 *
 * Es reemplazo y no agregado a propósito: es el único primitivo que permite
 * expresar las tres operaciones del DSL `$labels:` (+añadir / -quitar /
 * =reemplazar). Quien llama calcula el set final deseado — ver `applyLabelOps`
 * en el engine — y esta capa sólo lo persiste. Con un endpoint aditivo,
 * "quitar" sería inexpresable.
 *
 * Un array vacío borra todas las labels del issue, que es justamente lo que
 * `$labels:=` (reemplazar por nada) debe significar.
 */
export async function replaceIssueLabels(
  owner: string,
  repo: string,
  issueNumber: number,
  labels: string[],
): Promise<void> {
  await rest(`/repos/${owner}/${repo}/issues/${issueNumber}/labels`, {
    method: 'PUT',
    body: { labels },
  })
}
