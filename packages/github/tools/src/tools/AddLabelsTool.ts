import { z } from 'zod'
import { GithubTool } from '../GithubTool.js'

export const AddLabelsInput = z.strictObject({
  owner: z.string().describe('Dueño del repo, ej. "julianjab"'),
  repo: z.string().describe('Nombre del repo'),
  number: z.number().int().positive().describe('Número del issue'),
  labels: z.array(z.string().min(1)).min(1).describe('Labels a agregar'),
})
export type AddLabelsInput = z.infer<typeof AddLabelsInput>

export class AddLabelsTool extends GithubTool<typeof AddLabelsInput> {
  readonly name = 'github_add_labels'
  readonly description =
    'Agrega una o más labels a un issue de GitHub (no reemplaza las existentes).'
  readonly input = AddLabelsInput

  protected async execute(input: AddLabelsInput): Promise<string> {
    const updated = await this.client.requestJson<Array<{ name: string }>>(
      this.issuePath(input.owner, input.repo, input.number, '/labels'),
      { method: 'POST', body: JSON.stringify({ labels: input.labels }) },
    )
    return `Labels actuales: ${updated.map((label) => label.name).join(', ')}`
  }
}
