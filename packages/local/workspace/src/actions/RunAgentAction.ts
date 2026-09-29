import {
  Action,
  Agent,
  type PipelineExecutionContext,
  type ProviderRegistry,
  runForResult,
  type SideEffects,
} from '@ia-flow/agent-engine'
import type { BashPolicy } from '@ia-flow/shell-tools'
import { z } from 'zod'
import { type ClaudeAgent, readClaudeAgents } from './claudeAgents.js'
import type { WorkspaceSession } from './WorkspaceSession.js'
import { type WorkspaceActionOptions, workspaceAction } from './WorkspaceToolAction.js'

/** Las tools de Claude Code que tienen equivalente sobre el worktree. El resto se descarta. */
const TOOL_MAP: Record<string, string> = {
  Read: 'fs_read',
  Grep: 'fs_grep',
  Glob: 'fs_list',
  LS: 'fs_list',
  Edit: 'fs_edit',
  MultiEdit: 'fs_edit',
  Write: 'fs_write',
  Bash: 'bash_run',
}
const WRITES = new Set(['fs_edit', 'fs_write', 'bash_run'])

/** Los alias de modelo de Claude Code. `inherit` (o nada) = el default del provider. */
const DEFAULT_MODELS: Record<string, string> = {
  sonnet: 'claude-sonnet-5',
  opus: 'claude-opus-5',
  haiku: 'claude-haiku-4-5',
}

const RunAgentInput = z.strictObject({
  agent: z
    .string()
    .optional()
    .describe('El `name` del sub-agente. Sin esto, devuelve la lista de los que hay.'),
  brief: z
    .string()
    .optional()
    .describe(
      'Qué tiene que hacer, con TODO el contexto que necesita: no ve tu conversación, sólo esto.',
    ),
})

const SubagentBrief = z.strictObject({ brief: z.string() })

const SubagentResult = z.strictObject({
  summary: z.string().min(1).describe('Qué hiciste y qué encontraste, para quien te delegó.'),
})

export interface RunAgentOptions {
  /** El provider con el que corren los sub-agentes (ej. `anthropic-api`). */
  provider: string
  /** Default: el `providerRegistry` global. */
  registry?: ProviderRegistry
  /** Si los sub-agentes pueden escribir (`fs_write`, `fs_edit`, `bash_run`). Sin esto sólo leen,
   *  y la action no escribe: no necesita `allowWrite`. */
  write?: boolean
  /** La policy de su `bash_run` (la del padre). */
  policy?: BashPolicy
  /** Las opciones de su `bash_run` (credencial de git, timeouts). */
  bash?: WorkspaceActionOptions
  /** Alias de modelo → id. Default: sonnet/opus/haiku a los de la familia actual. */
  models?: Record<string, string>
  /** La config de provider de cada sub-agente (ej. `maxTokens`); el `model` sale del agente. */
  providerConfig?: Record<string, unknown>
}

/**
 * `run_agent`: delega en un sub-agente de Claude Code del REPO de la task (`.claude/agents/*.md`
 * del worktree), igual que la tool `Task` de Claude Code, pero corriendo en el engine: su cuerpo
 * es el system prompt, su `model` y sus `tools` se traducen (las tools a las de disco sobre el
 * mismo worktree). Bloquea al padre y le devuelve el resumen del hijo.
 *
 * El hijo corre fuera de la pipeline y de la ejecución: sin `run_agent` propio (no delega), sin
 * ocupar topes (ver `EngineOptions.limits`), sin reportes. Sólo escribe si la action se armó con
 * `write`.
 */
export class RunAgentAction extends Action<typeof RunAgentInput, string> {
  readonly description =
    'Delegá una tarea acotada en un sub-agente especializado del repo (sus `.claude/agents`), como la tool Task de Claude Code. Llamala sin `agent` para ver cuáles hay. El sub-agente no ve tu conversación: el `brief` tiene que traer todo el contexto. Te devuelve su resumen.'
  readonly input = RunAgentInput
  override readonly sideEffects: SideEffects

  constructor(
    private readonly session: WorkspaceSession,
    private readonly options: RunAgentOptions,
  ) {
    super({ id: 'run_agent' })
    this.sideEffects = options.write ? 'write' : 'none'
  }

  async execute(
    input: z.infer<typeof RunAgentInput>,
    ctx: PipelineExecutionContext,
  ): Promise<string> {
    const agents = await readClaudeAgents(await this.session.dirFor(ctx))
    if (agents.length === 0) return 'El repo no tiene sub-agentes (.claude/agents/*.md).'
    if (!input.agent) return catalog(agents)
    const found = agents.find((agent) => agent.name === input.agent)
    if (!found) throw new Error(`No hay un sub-agente "${input.agent}".\n\n${catalog(agents)}`)
    if (!input.brief?.trim())
      throw new Error('Falta el `brief`: qué tiene que hacer y con qué contexto.')

    const child = this.agentFor(found)
    // Fuera de la pipeline y de la ejecución: no se lo interrumpe, no espera eventos, no guarda
    // progreso, no ocupa topes. Mismo evento: sus tools de disco caen en el mismo worktree.
    const { execution: _e, limits: _l, saveProgress: _s, resume: _r, runStep: _rs, ...rest } = ctx
    const result = await runForResult(
      child,
      { ...rest, routesFor: undefined },
      { brief: input.brief },
      SubagentResult,
    )
    return SubagentResult.parse(result).summary
  }

  /** El `.md` de Claude Code como `Agent` del engine. */
  private agentFor(agent: ClaudeAgent): Agent {
    const { provider, registry, policy, bash, write, providerConfig } = this.options
    const names = new Set(
      (agent.tools ?? Object.keys(TOOL_MAP))
        .map((tool) => TOOL_MAP[tool])
        .filter((name): name is string => name !== undefined)
        .filter((name) => write || !WRITES.has(name)),
    )
    const actions = [...names].map((name) => {
      const action = workspaceAction(name, this.session, policy, bash)
      return WRITES.has(name) ? action.allowWrite() : action
    })
    const model = this.model(agent.model)
    return new Agent(
      {
        id: agent.name,
        provider,
        prompt: '{{input.brief}}',
        input: SubagentBrief,
        systemPrompts: [{ text: agent.prompt }],
        providerConfig: { ...providerConfig, ...(model ? { model } : {}) },
        actions,
      },
      ...(registry ? [registry] : []),
    )
  }

  private model(alias: string | undefined): string | undefined {
    if (!alias || alias === 'inherit') return undefined
    return { ...DEFAULT_MODELS, ...this.options.models }[alias] ?? alias
  }
}

function catalog(agents: ClaudeAgent[]): string {
  return [
    'Sub-agentes del repo:',
    ...agents.map((agent) => `- ${agent.name}: ${agent.description || '(sin descripción)'}`),
  ].join('\n')
}
