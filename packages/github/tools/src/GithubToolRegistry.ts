import { type ToolConstructor, ToolRegistry } from '@ia-flow/agent-engine'
import type { GithubClient } from '@ia-flow/github-api'
import { AddLabelsTool, CommentIssueTool, GetIssueTool, SearchIssuesTool } from './tools/index.js'

/**
 * Le da acceso a un `Agent` a las tools de GitHub por NOMBRE (`"github_get_issue"`, no un
 * método/import por tool). Auto-instanciación por clase vía `ToolRegistry` (agent-engine):
 * agregar una tool nueva es crear el archivo (extiende `GithubTool`) y sumar UNA línea
 * `GithubToolRegistry.register(SuClase)` acá abajo — nunca se toca el constructor de esta
 * clase ni `ToolRegistry`.
 *
 * El registro NO vive repartido en cada archivo de tool (que sería lo más "auto" posible) a
 * propósito: un tool file que hiciera `import { GithubToolRegistry } from
 * '../GithubToolRegistry.js'` para auto-registrarse crearía una dependencia circular real con
 * ESTE módulo (que a su vez necesita importar los archivos de tools) — y en ESM un ciclo así
 * cae en TDZ: `GithubToolRegistry` todavía no está inicializada en el módulo cuando el archivo
 * de la tool, importado en medio de la evaluación de ESTE archivo, intenta usarla. Centralizar
 * el `.register(...)` acá evita el ciclo sin perder el resto del auto-registro (nadie mantiene
 * a mano el array de instancias ni la lógica de construcción).
 */
export class GithubToolRegistry extends ToolRegistry<[GithubClient]> {
  protected static registeredTools: ToolConstructor<[GithubClient]>[] = []
}

GithubToolRegistry.register(GetIssueTool)
GithubToolRegistry.register(CommentIssueTool)
GithubToolRegistry.register(AddLabelsTool)
GithubToolRegistry.register(SearchIssuesTool)
