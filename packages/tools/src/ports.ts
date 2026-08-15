// Shared mutable slot for `SystemPromptPort` — consumed by both `engine.ts`
// (compactHistory) and `fs/fs.ts` (the Haiku file simplifier), which is why
// this lives in its own module instead of being private to either. Wired
// once by apps/server's composition/container.ts at startup.
import type { SystemPromptPort } from './contract.js'

let systemPromptPort: SystemPromptPort | null = null

export function setSystemPromptPort(port: SystemPromptPort | null): void {
  systemPromptPort = port
}

export function getSystemPromptPort(): SystemPromptPort | null {
  return systemPromptPort
}
