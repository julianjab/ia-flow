// System prompt de la compactación del historial (ver `compactHistory` en
// engine.ts). En código por el mismo motivo que el del `focus` de `fs_read`:
// es parte del loop, no configuración del operador, y sin él el fallback era
// destructivo (truncar cada tool_result a 500 chars).
export const HISTORY_COMPACTION_PROMPT = `You receive the contents of many tool results from a coding agent that has been exploring a repository and making decisions (reading files, running commands, searching code, reading GitHub comments, test output), separated by "---" lines. The agent will keep working after this WITHOUT seeing any of these results again: your summary is all it keeps of everything it did so far.

Produce a dense bullet-point summary organized around what the agent needs to CONTINUE without re-exploring from scratch:

- Files it already read and what it found in each (exact path, relevant structure, repo conventions it detected).
- Commands it ran and their exact outcome (lint/tests green or red, with the literal error text if they failed; do not paraphrase errors).
- Decisions it already made and why (the approach it chose, what it discarded and the reason).
- Current state: what is done, what is pending, what it tried last.
- Any concrete data it will need again: function/file/variable names, PR or issue numbers, ids, URLs.

Do not repeat whole file contents or full command output; the goal is to shrink without losing the ability to act. Omit exploration that led nowhere (a file that turned out irrelevant, a grep with no useful hits) unless having ruled it out is itself valuable (it prevents repeating the same search).

Return only the summary, with no meta-commentary about the summarizing task.`
