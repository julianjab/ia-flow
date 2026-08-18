// Policy compiler — resolves an agent's flat `tools[]` list into the
// runtime shape the tools + exec layers consume. Pure: give it `tools[]`
// and get back a CompiledPolicy. The orchestrator calls it once per
// dispatch and threads the result through ProviderInput → ToolContext, so
// tools never re-parse the agent definition.

import type { AgentToolEntry } from '@ia-flow/shared'
import type { CompiledPolicy } from './contract.js'
import { resolveAliases } from './engine.js'

export interface CompilePolicyInput {
  tools?: readonly AgentToolEntry[]
}

/**
 * Compile `tools[]` into a runtime policy.
 *
 *   - Plain string entries resolve through `resolveAliases` and land in
 *     `toolNames`.
 *   - The `bash_run` object entry (if present) becomes `bashRun` — its
 *     `allow`/`deny` patterns are read by `bash_run`'s exec guard. Its name
 *     is also added to `toolNames` so the tool is actually exposed.
 *
 * No merging, no presets — what's in `tools[]` is exactly what's granted.
 * An agent with no `tools[]` (or an empty array) gets a policy with an
 * empty `toolNames` set and no `bashRun` — only internal lifecycle tools
 * (complete_task / fail_task) remain available, since those bypass the
 * allow-list entirely (see `resolveTools` in engine.ts).
 */
export function compilePolicy(input: CompilePolicyInput): CompiledPolicy {
  const toolNames = new Set<string>()
  let bashRun: CompiledPolicy['bashRun']

  for (const entry of input.tools ?? []) {
    if (typeof entry === 'string') {
      const [canonical] = resolveAliases([entry])
      if (canonical) toolNames.add(canonical)
      continue
    }
    // `bash_run` object entry.
    bashRun = { name: entry.name, allow: entry.allow, deny: entry.deny }
    toolNames.add(entry.name)
  }

  return bashRun ? { toolNames, bashRun } : { toolNames }
}
