// Parse / write a `## Blocked by` markdown section inside a task description.
// The section is the local source's storage format for issue dependencies —
// GitHub uses its own native mechanism.

const HEADING = /^##\s+blocked by\s*$/im

/** Extract IDs listed under a `## Blocked by` section (empty if absent). */
export function parseBlockedBy(description: string): string[] {
  const match = HEADING.exec(description)
  if (!match) return []
  const start = match.index + match[0].length
  const rest = description.slice(start)
  // Read lines until the next `## ` heading (or EOF).
  const nextHeading = /^##\s+/m.exec(rest)
  const section = nextHeading ? rest.slice(0, nextHeading.index) : rest
  const ids: string[] = []
  for (const line of section.split('\n')) {
    const m = /^\s*-\s+#?([^\s]+)/.exec(line)
    if (m?.[1]) ids.push(m[1])
  }
  return ids
}

/**
 * Return a new description with `blockerId` added to the `## Blocked by`
 * section (creating the section at EOF if it doesn't exist). Idempotent —
 * a repeat call is a no-op.
 */
export function addBlockedBy(description: string, blockerId: string): string {
  const existing = parseBlockedBy(description)
  if (existing.includes(blockerId)) return description
  const updated = [...existing, blockerId]
  return writeBlockedBy(description, updated)
}

function writeBlockedBy(description: string, ids: string[]): string {
  const body = ids.map((id) => `- ${id}`).join('\n')
  const section = `## Blocked by\n${body}\n`
  const match = HEADING.exec(description)
  if (!match) {
    const sep = description.endsWith('\n') ? '\n' : '\n\n'
    return `${description}${sep}${section}`
  }
  const before = description.slice(0, match.index)
  const rest = description.slice(match.index + match[0].length)
  const nextHeading = /^##\s+/m.exec(rest)
  const after = nextHeading ? rest.slice(nextHeading.index) : ''
  return `${before}${section}${after ? `\n${after}` : ''}`
}
