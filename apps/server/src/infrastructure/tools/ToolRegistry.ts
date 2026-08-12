import type { IAgentProvider, ProviderKind } from '../../domain/ports/IAgentProvider.js'
import type { ITool } from '../../domain/ports/ITool.js'
import type { IToolRegistry } from '../../domain/ports/IToolRegistry.js'

const ALL_KINDS: ProviderKind[] = ['sync', 'async']

function toolAppliesTo(t: ITool, kind: ProviderKind): boolean {
  return (t.providerKinds ?? ALL_KINDS).includes(kind)
}

export class ToolRegistry implements IToolRegistry {
  private map = new Map<string, ITool>()

  register(tool: ITool): void {
    this.map.set(tool.name, tool)
  }

  get(name: string): ITool | undefined {
    return this.map.get(name)
  }

  list(): ITool[] {
    return [...this.map.values()]
  }

  buildToolInstructions(
    toolNames: string[] | undefined,
    provider: Pick<IAgentProvider, 'id' | 'kind'>,
    daemonUrl: string,
    taskId: string,
    opts?: { disabledTools?: string[] },
  ): string {
    if (provider.kind !== 'async') return ''

    const disabled = opts?.disabledTools?.length ? new Set(opts.disabledTools) : null
    const allowed = toolNames?.length ? new Set(toolNames) : null

    const candidates = [...this.map.values()].filter((t) => {
      if (disabled?.has(t.name)) return false
      if (!toolAppliesTo(t, 'async')) return false
      if (t.internal) return true
      if (!allowed) return true
      return allowed.has(t.name)
    })

    if (!candidates.length) return ''

    const blocks = candidates.map((t) => {
      const schema = t.input_schema as {
        properties?: Record<string, { description?: string; type?: string }>
        required?: string[]
      }
      const props = schema.properties ?? {}
      const body: Record<string, string> = {}
      for (const [key, def] of Object.entries(props)) {
        if (key === 'task_id') {
          body[key] = taskId
        } else if (def.description) {
          body[key] = `<${def.description.split('.')[0]}>`
        } else {
          body[key] = `<${key}>`
        }
      }
      const bodyStr = JSON.stringify(body)
      return [
        `### ${t.name}`,
        t.description,
        '```bash',
        `curl -s -X POST ${daemonUrl}/api/tools/${t.name} \\`,
        `  -H 'Content-Type: application/json' \\`,
        `  -d '${bodyStr}'`,
        '```',
      ].join('\n')
    })

    return ['## Herramientas disponibles', '', ...blocks].join('\n')
  }
}
