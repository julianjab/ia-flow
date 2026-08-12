import type { ITool } from '../../domain/ports/ITool.js'
import type { IToolRegistry } from '../../domain/ports/IToolRegistry.js'

const ASYNC_PROVIDERS = new Set(['tmux-claude', 'iterm-claude'])

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
    providerId: string,
    daemonUrl: string,
    taskId: string,
  ): string {
    if (!ASYNC_PROVIDERS.has(providerId)) return ''

    const pid = providerId as 'tmux-claude' | 'iterm-claude'
    const candidates = [...this.map.values()].filter((t) => {
      // `apiOnly` tools are excluded from every non-API provider — they need
      // the sandboxed `ToolContext.writePaths` scope that terminal Claude
      // sessions don't build.
      if (t.apiOnly) return false
      if (!t.providers?.[pid]) return false
      return toolNames?.length ? toolNames.includes(t.name) : true
    })

    if (!candidates.length) return ''

    const blocks = candidates.map((t) => {
      const spec = t.providers![pid]!
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
        `curl -s -X ${spec.method} ${daemonUrl}${spec.path} \\`,
        `  -H 'Content-Type: application/json' \\`,
        `  -d '${bodyStr}'`,
        '```',
      ].join('\n')
    })

    return ['## Herramientas disponibles', '', ...blocks].join('\n')
  }
}
