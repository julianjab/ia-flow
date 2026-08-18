import type { AgentDefinition } from '@ia-flow/shared'

// `repoName` is a logical reference into `repos` (see AgentActivationSchema),
// scoped by the agent's own projectId — not a SQL FK. Validated here instead
// of at the schema layer since it needs a DB lookup. Takes the candidate's
// set of valid repo names (already scoped by projectId) rather than a repo
// port directly, so this stays a pure function — testable without a DB, and
// importable from a test without dragging in `composition/container.js`
// (which opens a real SQLite connection and runs migrations as a side
// effect of being imported).
export function repoNameError(agent: AgentDefinition, validRepoNames: Set<string>): string | null {
  if (!agent.repoName || !agent.projectId) return null
  if (!validRepoNames.has(agent.repoName)) {
    return `repoName '${agent.repoName}' does not exist in project '${agent.projectId}'`
  }
  return null
}
