import type { Component } from 'vue'
import AnthropicApiProviderForm from './AnthropicApiProviderForm.vue'
import JsonProviderForm from './JsonProviderForm.vue'
import TerminalClaudeProviderForm from './TerminalClaudeProviderForm.vue'

// Registry: provider id → the form component that edits its providerConfig.
// Adding a new provider with a dedicated form: add an entry here. Without
// an entry, `providerFormFor` returns `JsonProviderForm` and the provider
// stays editable as a raw JSON blob.
//
// Kept in sync manually with apps/server/src/providers/index.ts. There is
// no runtime coupling between them — the server owns the truth of "which
// providers exist"; this registry only decides which UI to render.
const REGISTRY: Record<string, Component> = {
  'anthropic-api': AnthropicApiProviderForm,
  'tmux-claude': TerminalClaudeProviderForm,
  'iterm-claude': TerminalClaudeProviderForm,
}

export function providerFormFor(providerId: string): Component {
  return REGISTRY[providerId] ?? JsonProviderForm
}

export function hasDedicatedForm(providerId: string): boolean {
  return providerId in REGISTRY
}
