// Parse / write `## Blocked by` and `## Blocks` markdown sections inside a
// task description. Local source's storage format for issue dependencies —
// GitHub uses its own native mechanism.

const BLOCKED_BY_HEADING = /^##\s+blocked by\s*$/im
const BLOCKS_HEADING = /^##\s+blocks\s*$/im

/** Extract IDs listed under a `## Blocked by` section (empty if absent). */
export function parseBlockedBy(description: string): string[] {
  return parseSection(description, BLOCKED_BY_HEADING)
}

/** Extract IDs listed under a `## Blocks` section (empty if absent). */
export function parseBlocks(description: string): string[] {
  return parseSection(description, BLOCKS_HEADING)
}

/**
 * Return a new description with `blockerId` added to the `## Blocked by`
 * section (creating it at EOF if missing). Idempotent.
 */
export function addBlockedBy(description: string, blockerId: string): string {
  return addToSection(description, BLOCKED_BY_HEADING, 'Blocked by', blockerId)
}

/**
 * Return a new description with `blockedId` added to the `## Blocks`
 * section (creating it at EOF if missing). Idempotent.
 */
export function addBlocks(description: string, blockedId: string): string {
  return addToSection(description, BLOCKS_HEADING, 'Blocks', blockedId)
}

function parseSection(description: string, heading: RegExp): string[] {
  const match = heading.exec(description)
  if (!match) return []
  const start = match.index + match[0].length
  const rest = description.slice(start)
  const nextHeading = /^##\s+/m.exec(rest)
  const section = nextHeading ? rest.slice(0, nextHeading.index) : rest
  const ids: string[] = []
  for (const line of section.split('\n')) {
    const m = /^\s*-\s+#?([^\s]+)/.exec(line)
    if (m?.[1]) ids.push(m[1])
  }
  return ids
}

function addToSection(description: string, heading: RegExp, title: string, id: string): string {
  const existing = parseSection(description, heading)
  if (existing.includes(id)) return description
  return writeSection(description, heading, title, [...existing, id])
}

function writeSection(description: string, heading: RegExp, title: string, ids: string[]): string {
  const body = ids.map((v) => `- ${v}`).join('\n')
  const section = `## ${title}\n${body}\n`
  const match = heading.exec(description)
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
