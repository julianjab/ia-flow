// Matcher for `bash_run` allow/deny patterns — prefix+wildcard, same mental
// model as Claude Code's `Bash(cmd:*)` rules but token-based instead of
// string-based. No regex: patterns are split on whitespace like the command
// itself, so what's written is what's matched.
//
//   - A token ending in "*" (e.g. "task/*") prefix-matches the corresponding
//     command token.
//   - A bare "*" token matches any single command token — UNLESS it's the
//     last token in the pattern, in which case it consumes the rest of the
//     command (zero or more tokens). This is what makes "npm run *" match
//     "npm run test:unit -- --watch".
//   - Anything else must match the command token exactly.
//   - A pattern with no trailing "*" requires an exact token-count match.

export function matchesBashPattern(command: readonly string[], pattern: string): boolean {
  const patternTokens = pattern.trim().split(/\s+/).filter(Boolean)
  if (patternTokens.length === 0) return false

  for (let i = 0; i < patternTokens.length; i++) {
    const pTok = patternTokens[i] as string
    const isLast = i === patternTokens.length - 1
    if (isLast && pTok === '*') return true // consumes the rest of the command

    const cTok = command[i]
    if (cTok === undefined) return false
    if (pTok === '*') continue // wildcard token — matches any single token
    if (pTok.endsWith('*')) {
      if (!cTok.startsWith(pTok.slice(0, -1))) return false
      continue
    }
    if (cTok !== pTok) return false
  }

  return command.length === patternTokens.length
}

export interface BashPatternConfig {
  allow: readonly string[]
  deny: readonly string[]
}

/** `deny` wins over `allow`; a command that matches no `allow` pattern is
 *  rejected by default. */
export function isBashCommandAllowed(
  command: readonly string[],
  config: BashPatternConfig,
): boolean {
  if (config.deny.some((p) => matchesBashPattern(command, p))) return false
  return config.allow.some((p) => matchesBashPattern(command, p))
}
