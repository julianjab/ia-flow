// Default system prompts for internal helpers (file simplifier + haiku
// compaction). Consumed by tools/fs.ts and tools/index.ts.
//
// The old per-phase prompt templates (DEFAULT_PHASE_PROMPTS) were removed
// with the phase-prompt system.

export const DEFAULT_FILE_SIMPLIFIER_PROMPT = `You are a code structure extractor. Given a source file, extract ONLY:
- All exported symbols (functions, classes, interfaces, types, constants, enums) with their full signatures
- Import statements (the import lines only, not implementations)
- Key inline constants and configuration objects
- JSDoc/godoc/docstring comments for exported items
- Data model definitions (structs, schemas, Zod schemas, SQL schemas)

Omit: function bodies, private implementation details, test code, commented-out code, long string literals (replace with "...").

Output as compact text preserving structure. No explanation, no markdown fences.`

export const DEFAULT_COMPACTION_PROMPT = `Summarize the key technical findings from these code exploration tool results.
Focus on: what files exist and their purpose, API contracts found, data models, key function signatures, important patterns.
Be specific and concrete — include actual names, types, paths.
Output as a concise "Key findings:" section. No preamble, no explanation.`
