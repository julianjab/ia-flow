// Carga de `base-agents.yaml` — agentes/reglas intrínsecos del engine,
// versionados con el código (ver el header de ese archivo). Reusa el MISMO
// parser y los MISMOS schemas Zod que ya validan un `runner.yaml`
// (AgentDefinitionSchema/RuleSchema de @ia-flow/shared), en vez de escribir
// un parser nuevo — la única diferencia es que este archivo es chico y fijo,
// no admite las carpetas `projects/`/`agents/` sueltas del runner.
import { readFileSync } from 'node:fs'
import type { AgentDefinition, Rule } from '@ia-flow/shared'
import { AgentDefinitionSchema, RuleSchema } from '@ia-flow/shared'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'

const BaseAgentsFileSchema = z
  .object({
    agents: AgentDefinitionSchema.array().default([]),
    rules: RuleSchema.array().default([]),
  })
  .strict()

export interface BaseAgentsConfig {
  agents: AgentDefinition[]
  rules: Rule[]
}

/** Puro — sin I/O. Es lo que `composition/container.ts` llama, contra el
 *  texto que Bun embebió en el bundle en build time (ver `yaml-text.d.ts`):
 *  un `readFileSync` relativo a `import.meta.url` no encontraría el YAML en
 *  el bundle de un solo archivo del flavor `runner` (sin `node_modules` ni
 *  el resto del repo al lado — ver Dockerfile.runner). */
export function loadBaseAgentsFromText(raw: string): BaseAgentsConfig {
  const result = BaseAgentsFileSchema.safeParse(parseYaml(raw))
  if (!result.success) {
    throw new Error(`base-agents.yaml no cumple el schema de agentes base: ${result.error.message}`)
  }
  return result.data
}

/** Wrapper con I/O — sólo para tests, que sí pueden leer el archivo del
 *  disco del repo directamente. El código de producción usa
 *  `loadBaseAgentsFromText` con el texto embebido, no esto. */
export function loadBaseAgents(filePath: string): BaseAgentsConfig {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf-8')
  } catch (err) {
    throw new Error(`No se pudo leer '${filePath}': ${(err as Error).message}`)
  }
  return loadBaseAgentsFromText(raw)
}
