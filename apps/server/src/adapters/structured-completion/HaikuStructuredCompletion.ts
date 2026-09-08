import { askHaiku, haikuAuthHeader } from '@ia-flow/tools'
import type {
  IStructuredCompletion,
  StructuredCompletionRequest,
} from '../../domain/ports/IStructuredCompletion.js'

/**
 * `IStructuredCompletion` sobre Haiku.
 *
 * Haiku y no el modelo del agente, por lo mismo que el `focus` de `fs_read` y
 * la compactación del historial: son ayudantes internos con su propio
 * presupuesto, y no deben encarecerse porque alguien puso Opus en un agente.
 *
 * La credencial se lee POR LLAMADA (`haikuAuthHeader` mira `Bun.env` cada
 * vez), no en el constructor: `envRepo.loadIntoProcess()` vuelca lo guardado
 * en SQLite DESPUÉS de que el composition root se evaluó, así que capturarla
 * acá dejaría al adapter ciego a lo que el operador pegó en Configuración —
 * es la misma regla que las credenciales de GitHub.
 */
export class HaikuStructuredCompletion implements IStructuredCompletion {
  isAvailable(): boolean {
    return haikuAuthHeader() !== null
  }

  async complete(req: StructuredCompletionRequest): Promise<Record<string, unknown> | null> {
    const res = await askHaiku({
      system: req.system,
      user: req.user,
      maxTokens: req.maxTokens,
      scope: req.scope,
      tool: {
        name: req.toolName,
        description: req.toolDescription,
        inputSchema: req.schema,
      },
    })
    return res.toolInput
  }
}
