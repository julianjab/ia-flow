export interface SystemPromptEntryProps {
  id: string
  text: string
}

/** Catálogo de system prompts reusables que `Agent.systemPrompts[].id`
 *  referencia — cuando esa entrada ya trae `text` inline, no hace falta
 *  resolver acá. */
export class SystemPromptEntry {
  private static readonly byId = new Map<string, SystemPromptEntry>()

  readonly id: string
  readonly text: string

  constructor(props: SystemPromptEntryProps) {
    this.id = props.id
    this.text = props.text
  }

  static register(entry: SystemPromptEntry): void {
    throw new Error('not implemented — SystemPromptEntry.byId.set(entry.id, entry)')
  }

  static resolve(id: string): SystemPromptEntry | undefined {
    throw new Error('not implemented — SystemPromptEntry.byId.get(id)')
  }

  /** Sólo para tests — vacía el índice estático entre corridas aisladas. */
  static reset(): void {
    throw new Error('not implemented — SystemPromptEntry.byId.clear()')
  }
}
