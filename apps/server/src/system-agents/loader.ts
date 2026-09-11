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

export function loadBaseAgents(filePath: string): BaseAgentsConfig {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf-8')
  } catch (err) {
    throw new Error(`No se pudo leer '${filePath}': ${(err as Error).message}`)
  }
  const result = BaseAgentsFileSchema.safeParse(parseYaml(raw))
  if (!result.success) {
    throw new Error(`'${filePath}' no cumple el schema de agentes base: ${result.error.message}`)
  }
  return result.data
}
