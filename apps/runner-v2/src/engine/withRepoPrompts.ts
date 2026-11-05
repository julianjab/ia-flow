/**
 * Las notas de los repos (`prompt` en `repos/*.yaml`) en el prompt de cada agente de un proyecto,
 * sin tocar sus YAML: al montar la fuente se le suma `{{task.repo_prompts}}` al final del prompt
 * de cada agente, y al correr la resuelve el `PromptRenderer` contra el payload de la task (lo arma
 * el intake, `intake/repoPrompts.ts`, sólo con las notas del repo de esa task).
 *
 * Va en el prompt del USUARIO, no en un system prompt: los system prompts son el prefijo cacheado
 * del agente (`cache_control` en la Messages API, `--append-system-prompt-file` en el CLI) y un
 * texto que cambia con el repo partiría ese cache en uno por repo. Al final del prompt, además, el
 * prefijo estático del agente queda igual entre repos. Y el prompt ya armado es lo que viaja a un
 * host remoto (`remote:*`) y al provider `anthropic-api`: las notas llegan a todos sin más.
 *
 * Un agente cuyo prompt ya nombra `{{task.repo_prompts}}` decide dónde van: no se suma otra vez.
 */
import type { DefinitionSource } from '@ia-flow/agent-engine-definitions'
import { REPO_PROMPTS_VAR } from '../intake/repoPrompts.js'

const PLACEHOLDER = `{{${REPO_PROMPTS_VAR}}}`
const NAMED = new RegExp(`\\{\\{\\s*${REPO_PROMPTS_VAR.replace('.', '\\.')}\\s*\\}\\}`)

/** El prompt de un agente con las notas de los repos al final (si no las ubica él). */
export function withRepoPromptsSection(prompt: string): string {
  return NAMED.test(prompt) ? prompt : `${prompt.trimEnd()}\n\n${PLACEHOLDER}`
}

export function withRepoPrompts(datasource: DefinitionSource): DefinitionSource {
  return {
    version: () => datasource.version(),
    read: () => {
      const docs = datasource.read()
      return {
        ...docs,
        agents: docs.agents.map((located) => ({
          ...located,
          doc: { ...located.doc, prompt: withRepoPromptsSection(located.doc.prompt) },
        })),
      }
    },
  }
}
