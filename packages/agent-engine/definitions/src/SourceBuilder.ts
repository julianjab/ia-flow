import {
  type Action,
  Agent,
  type AllowedAction,
  Condition,
  END,
  type ErrorRoute,
  type ExitDefaults,
  type ExitRoute,
  type InterruptRoute,
  type McpServerRef,
  Pipeline,
  type RouteTarget,
  type RouteTo,
  type Runnable,
  StaticPipelineSource,
  type Tool,
  type ToolInputSchema,
  type WhenText,
} from '@ia-flow/agent-engine'
import { createLogger } from '@ia-flow/telemetry'
import { z } from 'zod'
import { type Catalogs, lookup, type ToolLookup } from './Catalogs.js'
import { located } from './located.js'
import type { AgentVariant, StepBuildContext } from './StepFactory.js'
import { StepFactoryRegistry } from './StepFactoryRegistry.js'
import type {
  AgentDoc,
  ErrorRouteNode,
  ExitRouteNode,
  InterruptRouteNode,
  PipelineDoc,
  SourceDoc,
  WhenTextNode,
} from './schema.js'

/** Un documento con el archivo del que salió. */
export interface Located<T> {
  path: string
  doc: T
}

/** Lo que se leyó de la carpeta de una fuente. */
export interface SourceDocs {
  /** El id de la fuente: lo decide el datasource (o quien lo monta). */
  id: string
  source: Located<SourceDoc>
  agents: Located<AgentDoc>[]
  pipelines: Located<PipelineDoc>[]
}

const RefNode = z.strictObject({ ref: z.string().min(1) })

type DefaultsNode = {
  onError?: z.infer<typeof ErrorRouteNode> | null
  onInterrupt?: z.infer<typeof InterruptRouteNode> | null
  report?: Record<string, unknown> | null
}

/**
 * Arma la fuente de pipelines de una carpeta (`StaticPipelineSource` con su id y sus
 * defaults) a partir de sus documentos: agentes (uno por id, compartido por todas las
 * pipelines de la fuente), pipelines y los defaults de la fuente. Cada paso lo arma su factory
 * (`StepFactoryRegistry`); `{ ref: <id> }` reusa un paso ya declarado antes en el `do` de la
 * misma pipeline. Se usa una vez por carga.
 */
export class SourceBuilder {
  readonly log = createLogger('agent-engine.definitions')
  private readonly steps: StepFactoryRegistry
  private sourceId = ''
  private sourceSystemPrompts: NonNullable<SourceDoc['systemPrompts']> = []
  private readonly agentDocs = new Map<string, Located<AgentDoc>>()
  private readonly agents = new Map<string, Agent>()
  private readonly building = new Set<string>()

  constructor(private readonly catalogs: Catalogs = {}) {
    this.steps = new StepFactoryRegistry(catalogs.steps)
  }

  build(docs: SourceDocs): StaticPipelineSource {
    this.sourceId = docs.id
    this.sourceSystemPrompts = docs.source.doc.systemPrompts ?? []
    for (const located of docs.agents) {
      const existing = this.agentDocs.get(located.doc.id)
      if (existing) {
        throw new Error(
          `${located.path}: el agente "${located.doc.id}" ya está definido en ${existing.path}`,
        )
      }
      this.agentDocs.set(located.doc.id, located)
    }
    const pipelines = docs.pipelines.map((located) => this.pipeline(located))
    const { path, doc } = docs.source
    const context = this.context(path, new Map())
    return located(
      path,
      () =>
        new StaticPipelineSource(pipelines, {
          id: this.sourceId,
          defaults: this.defaults(doc, context, path),
          capabilities: this.capabilities(doc, context, path),
        }),
    )
  }

  /** El agente de la fuente: el compartido, o una instancia propia de un paso (`variant`). */
  private agent(id: string, variant?: AgentVariant): Agent {
    const built = variant ? undefined : this.agents.get(id)
    if (built) return built
    const located = this.agentDocs.get(id)
    if (!located) {
      throw new Error(
        `no hay un agente "${id}" en agents/ — hay: ${[...this.agentDocs.keys()].join(', ') || 'ninguno'}`,
      )
    }
    if (this.building.has(id)) {
      throw new Error(`${located.path}: el agente "${id}" se referencia a sí mismo al armarse`)
    }
    this.building.add(id)
    const agent = this.buildAgent(located, variant)
    this.building.delete(id)
    if (!variant) this.agents.set(id, agent)
    return agent
  }

  private buildAgent({ path, doc }: Located<AgentDoc>, variant: AgentVariant = {}): Agent {
    const context = this.context(path, new Map(), doc.id)
    const where = (rel: string) => `${path}: ${rel}`
    return located(
      path,
      () =>
        new Agent(
          {
            id: doc.id,
            ...(doc.provider ? { provider: doc.provider } : {}),
            ...(doc.providers
              ? {
                  providers: doc.providers.map((choice, i) => ({
                    id: choice.id,
                    ...(choice.config ? { config: choice.config } : {}),
                    when: Condition.fromRows(choice.when),
                    ...located(where(`providers[${i}].whenText`), () =>
                      this.whenText(choice.whenText),
                    ),
                  })),
                }
              : {}),
            prompt: variant.brief ? `${variant.brief.trim()}\n\n${doc.prompt}` : doc.prompt,
            ...(doc.input ? { input: this.input(doc.input) } : {}),
            systemPrompts: this.agentSystemPrompts(
              [...this.sourceSystemPrompts, ...(doc.systemPrompts ?? [])],
              doc.id,
            ),
            variables: doc.variables,
            tools: doc.tools?.map((name) => this.tool(name)),
            actions: doc.actions?.flatMap((entry) =>
              this.agentActions(entry, doc.id, doc.allowWrites ?? false),
            ),
            onStart: doc.onStart?.map((node, i) => context.step(node, where(`onStart[${i}]`))),
            injects: doc.injects?.map((filter) => ({
              on: filter.on,
              when: Condition.fromRows(filter.when),
            })),
            ...(doc.waits ? { waits: doc.waits } : {}),
            ...(doc.maxConcurrent !== undefined ? { maxConcurrent: doc.maxConcurrent } : {}),
            providerConfig: doc.providerConfig,
            mcpServers: this.mcpServers(doc.mcpServers, where('mcpServers')),
            continueOnError: doc.continueOnError,
            when: [...Condition.fromRows(doc.when), ...(variant.when ?? [])],
            ...(variant.whenText
              ? { whenText: variant.whenText }
              : located(where('whenText'), () => this.whenText(doc.whenText))),
            routes: this.exitRoutes(doc.routes, context, where('routes')) as Record<
              string,
              ExitRoute
            >,
            ...this.defaults(doc, context, path),
          },
          this.catalogs.providers,
          this.catalogs.systemPrompts,
        ),
    )
  }

  private pipeline({ path, doc }: Located<PipelineDoc>): Pipeline {
    const local = new Map<string, Runnable>()
    const context = this.context(path, local)
    const steps = doc.do.map((node, i) => {
      const step = context.step(node, `${path}: do[${i}]`)
      if (step.id) local.set(step.id, step)
      return step
    })
    const routes = Object.fromEntries(
      Object.entries(doc.routes ?? {}).map(([agentId, override]) => [
        agentId,
        {
          routes: this.exitRoutes(override.routes, context, `${path}: routes.${agentId}.routes`),
          ...this.defaults(override, context, `${path}: routes.${agentId}`),
        },
      ]),
    )
    return located(
      path,
      () =>
        new Pipeline({
          id: doc.id,
          on: doc.on,
          scope: doc.scope,
          enabled: doc.enabled,
          position: doc.position,
          exclusive: doc.exclusive,
          firstMatch: doc.firstMatch,
          ifRunning: doc.ifRunning,
          ...(doc.interruptOn
            ? {
                interruptOn: doc.interruptOn.map((filter) => ({
                  on: filter.on,
                  when: Condition.fromRows(filter.when),
                })),
              }
            : {}),
          ifPaused: doc.ifPaused,
          ifQueued: doc.ifQueued,
          when: Condition.fromRows(doc.when),
          ...located(`${path}: whenText`, () => this.whenText(doc.whenText)),
          do: steps,
          routes,
          ...this.defaults(doc, context, path),
        }),
    )
  }

  private context(path: string, local: Map<string, Runnable>, agentId?: string): StepBuildContext {
    const make = (where: string): StepBuildContext => ({
      catalogs: this.catalogs,
      sourceId: this.sourceId,
      ...(agentId !== undefined ? { agentId } : {}),
      where,
      step: (node, at) => this.step(node, at, local, make(at)),
      routeTo: (node, at) => this.routeTo(node, make(at)),
      agent: (id, variant) => located(where, () => this.agent(id, variant)),
      action: (name, options) => this.action(name, agentId, options),
      whenText: (node) => located(`${where}: whenText`, () => this.whenText(node)),
    })
    return make(path)
  }

  private step(
    node: unknown,
    where: string,
    local: Map<string, Runnable>,
    context: StepBuildContext,
  ): Runnable {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) {
      throw new Error(`${where}: un paso es un objeto (ej. { action: postComment })`)
    }
    const ref = RefNode.safeParse(node)
    if (ref.success) {
      const step = local.get(ref.data.ref)
      if (!step) {
        throw new Error(
          `${where}: no hay un paso con id "${ref.data.ref}" antes en el do de esta pipeline`,
        )
      }
      return step
    }
    return this.steps.create(node as Record<string, unknown>, context)
  }

  private routeTo(node: unknown, context: StepBuildContext): RouteTo | undefined {
    if (node === undefined) return undefined
    const target = (entry: unknown, at: string): RouteTarget =>
      entry === 'end' ? END : context.step(entry, at)
    if (Array.isArray(node)) {
      return node.map((entry, i) => target(entry, `${context.where}[${i}]`))
    }
    return target(node, context.where)
  }

  private exitRoutes(
    routes: Record<string, z.infer<typeof ExitRouteNode> | null> | undefined,
    context: StepBuildContext,
    where: string,
  ): Record<string, ExitRoute | null> | undefined {
    if (!routes) return undefined
    return Object.fromEntries(
      Object.entries(routes).map(([name, route]) => {
        if (route === null) return [name, null]
        const to = context.routeTo(route.to, `${where}.${name}.to`)
        return [
          name,
          {
            ...(route.when !== undefined ? { when: route.when } : {}),
            ...(to !== undefined ? { to } : {}),
            ...(route.report !== undefined
              ? {
                  report:
                    route.report === null
                      ? null
                      : context.step(route.report, `${where}.${name}.report`),
                }
              : {}),
          },
        ]
      }),
    )
  }

  private capabilities(
    doc: SourceDoc,
    context: StepBuildContext,
    where: string,
  ): Record<string, Runnable> {
    return Object.fromEntries(
      Object.entries(doc.capabilities ?? {}).map(([name, node]) => [
        name,
        context.step(node, `${where}: capabilities.${name}`),
      ]),
    )
  }

  private defaults(node: DefaultsNode, context: StepBuildContext, where: string): ExitDefaults {
    return {
      ...(node.onError !== undefined
        ? {
            onError: node.onError === null ? null : this.errorRoute(node.onError, context, where),
          }
        : {}),
      ...(node.onInterrupt !== undefined
        ? {
            onInterrupt:
              node.onInterrupt === null
                ? null
                : this.interruptRoute(node.onInterrupt, context, where),
          }
        : {}),
      ...(node.report !== undefined
        ? {
            report: node.report === null ? null : context.step(node.report, `${where}: report`),
          }
        : {}),
    }
  }

  private interruptRoute(
    node: z.infer<typeof InterruptRouteNode>,
    context: StepBuildContext,
    where: string,
  ): InterruptRoute {
    const to = context.routeTo(node.to, `${where}: onInterrupt.to`)
    return to !== undefined ? { to } : {}
  }

  private errorRoute(
    node: z.infer<typeof ErrorRouteNode>,
    context: StepBuildContext,
    where: string,
  ): ErrorRoute {
    const to = context.routeTo(node.to, `${where}: onError.to`)
    const mapper = (name: string) =>
      located(`${where}: onError`, () => lookup(this.catalogs.mappers, name, 'un mapper'))
    return {
      ...(to !== undefined ? { to } : {}),
      ...(node.input ? { input: mapper(node.input) } : {}),
      ...(node.report ? { report: mapper(node.report) } : {}),
    }
  }

  private tool(name: string): Tool {
    const tools = this.catalogs.tools
    if (tools && typeof (tools as ToolLookup).get === 'function') {
      return (tools as ToolLookup).get(name)
    }
    return lookup(tools as Record<string, Tool> | undefined, name, 'una tool')
  }

  /**
   * Un `whenText` del YAML, con sus system prompts resueltos a texto: por id, uno del
   * `source.yaml` (con ese `id`) o del catálogo; inline, `{ text }`. Un id que no existe rompe la
   * carga — un gate que corre sin las instrucciones que se le pidieron decidiría otra cosa.
   */
  private whenText(node: WhenTextNode | undefined): { whenText?: WhenText } {
    if (node === undefined) return {}
    if (typeof node === 'string') return { whenText: { text: node } }
    const systemPrompts = (node.systemPrompts ?? []).map((ref) =>
      typeof ref === 'string' ? this.systemPrompt(ref) : ref.text,
    )
    return {
      whenText: {
        text: node.text,
        ...(systemPrompts.length > 0 ? { systemPrompts } : {}),
      },
    }
  }

  /**
   * Los system prompts de un agente, con los que nombra por `id` (sin `text`) ya resueltos: uno de
   * la fuente con ese `id`, o del catálogo (ej. los que trae una app para todos sus agentes). Un id
   * que no existe rompe la carga: el agente correría sin las instrucciones que se le pidieron.
   */
  private agentSystemPrompts(
    refs: NonNullable<SourceDoc['systemPrompts']>,
    agentId: string,
  ): NonNullable<SourceDoc['systemPrompts']> {
    return refs.map((ref) => {
      if (ref.text !== undefined || ref.id === undefined) return ref
      try {
        return { id: ref.id, text: this.systemPrompt(ref.id) }
      } catch (err) {
        throw new Error(`agente "${agentId}": ${(err as Error).message}`)
      }
    })
  }

  private systemPrompt(id: string): string {
    const own = this.sourceSystemPrompts.find((ref) => ref.id === id)?.text
    const found = own ?? this.catalogs.systemPrompts?.resolve(id)
    if (found === undefined) {
      const declared = this.sourceSystemPrompts.flatMap((ref) => (ref.id ? [ref.id] : []))
      throw new Error(
        `no hay un system prompt "${id}"${declared.length > 0 ? ` — la fuente declara: ${declared.join(', ')}` : ''} (ni en el catálogo)`,
      )
    }
    return found
  }

  /** La acción `name` del catálogo — armada para esta fuente y agente si es un `ActionProvider`. */
  private action(
    name: string,
    agentId: string | undefined,
    options: Record<string, unknown> | undefined,
  ): Action | Action[] {
    const entry = lookup(this.catalogs.actions, name, 'una acción')
    if (typeof entry === 'function') {
      return entry({
        sourceId: this.sourceId,
        ...(agentId !== undefined ? { agentId } : {}),
        options: options ?? {},
      })
    }
    if (options) throw new Error(`la acción "${name}" es fija: no acepta \`options\``)
    return entry
  }

  private agentActions(
    entry: NonNullable<AgentDoc['actions']>[number],
    agentId: string,
    allowWrites: boolean,
  ): Array<Action | AllowedAction> {
    const {
      action: name,
      with: fixed,
      options,
      allowWrite,
    } = typeof entry === 'string' ? { action: entry } : entry
    return [this.action(name, agentId, options)].flat().map((action) => {
      const bound = fixed ? action.bind(fixed as Partial<unknown>) : action
      return allowWrite || allowWrites ? bound.allowWrite() : bound
    })
  }

  /** `input` por nombre de schema, o los campos inline. */
  private input(input: NonNullable<AgentDoc['input']>): ToolInputSchema {
    if (typeof input === 'string') return lookup(this.catalogs.schemas, input, 'un schema')
    const shape = Object.fromEntries(
      Object.entries(input).map(([name, field]) => {
        let schema: z.ZodType =
          field.type === 'number' ? z.number() : field.type === 'boolean' ? z.boolean() : z.string()
        if (field.description) schema = schema.describe(field.description)
        if (field.optional) schema = schema.optional()
        return [name, schema] as const
      }),
    )
    return z.strictObject(shape) as unknown as ToolInputSchema
  }

  /** Los MCP del agente: los inline, y los del catálogo por id. Un id que el catálogo no tiene (ej.
   *  un servidor que no respondió al arrancar) se omite con un aviso: el agente corre sin él. */
  private mcpServers(refs: AgentDoc['mcpServers'], where: string): McpServerRef[] | undefined {
    if (!refs) return undefined
    return refs.flatMap((ref) => {
      if (typeof ref !== 'string') return [ref]
      const server = this.catalogs.mcpServers?.[ref]
      if (!server) {
        this.log.warn(`${where}: el MCP "${ref}" no está en el catálogo — el agente corre sin él`)
        return []
      }
      return [server]
    })
  }
}
