import { getPayloadWriter } from '../infra/PayloadWriter.js'
import { getShellRunner } from '../infra/ShellRunner.js'
import { Conditional, type ConditionalProps } from '../pipeline/Conditional.js'
import { Catalog } from '../shared/Catalog.js'
import { Execution } from './Execution.js'
import { ExecutionLog } from './ExecutionLog.js'
import { McpCatalogEntry } from './McpCatalogEntry.js'
import { Provider } from './Provider.js'
import { SystemPromptEntry } from './SystemPromptEntry.js'
import { Tool } from './Tool.js'
import type { WorkspacePlan, WorkspaceRequest } from './Workspace.js'

export type CommentTarget = 'issue' | 'pr' | 'pr-else-issue' | 'none'

/** Salida corta: sólo el nombre de status (`$set:`). Salida larga: además
 *  declara cuándo usarla (viaja al enum de `select_exit`) y dónde comentar. */
export type AgentExit = string | { set: string; when?: string; comment?: CommentTarget }

export const SUCCESS_EXIT = 'success'
export const ERROR_EXIT = 'error'

/** Outcomes que NO aplican ninguna transición — el run se cortó desde afuera
 *  (cancel manual, upstream abort truncando el stream), no es un resultado
 *  del agente. Ver Agent.matchExit. */
export const NO_TRANSITION_OUTCOMES = ['cancelled', 'truncated'] as const
export type NoTransitionOutcome = (typeof NO_TRANSITION_OUTCOMES)[number]

export function exitSet(exit: AgentExit | undefined): string | undefined {
  if (exit == null) return undefined
  return typeof exit === 'string' ? exit : exit.set
}

export function exitComment(exit: AgentExit | undefined): CommentTarget | undefined {
  return exit == null || typeof exit === 'string' ? undefined : exit.comment
}

/** salida > agente > default ('pr-else-issue'). */
export function resolveCommentTarget(
  exit: AgentExit | undefined,
  agentDefault: CommentTarget | undefined,
): CommentTarget {
  return exitComment(exit) ?? agentDefault ?? 'pr-else-issue'
}

export interface AgentProviderChoiceProps extends ConditionalProps {
  providerId: string
}

/** Un candidato dentro de un `Agent.provider` array. Hereda `when`/`whenText`
 *  de `Conditional` — acá desempatan entre VARIOS providers candidatos, a
 *  diferencia del `whenText` de `Pipeline`/`AgentActivation`, que decide si el
 *  ÚNICO candidato corre o no. Mismo campo, semántica distinta por contexto. */
export class AgentProviderChoice extends Conditional {
  readonly providerId: string

  constructor(props: AgentProviderChoiceProps) {
    super(props)
    this.providerId = props.providerId
  }
}

/** string = un solo provider, resuelto directo. Array = varios candidatos,
 *  desempatados por `when`/`whenText` (o un clasificador si hay >1 y ninguno resuelve). */
export type AgentProvider = string | AgentProviderChoice[]

export interface BashRunConfig {
  name: 'bash_run'
  allow: string[]
  deny: string[]
}

export type AgentToolEntry = string | BashRunConfig

export type AgentVariableValue = string | { value: string; full?: string; description?: string }

export interface AgentOutputField {
  type: 'string' | 'number' | 'boolean'
  description?: string
  enum?: string[]
  optional?: boolean
}

export type AgentOutput = Record<string, AgentOutputField>

export interface SystemPromptRef {
  id?: string
  text?: string
}

export interface AgentDefinitionProps {
  id: string
  provider: AgentProvider
  prompt: string
  systemPrompts?: SystemPromptRef[]
  variables?: Record<string, AgentVariableValue>
  tools?: AgentToolEntry[]
  saveOutput?: boolean
  providerConfig?: Record<string, unknown>
  mcpCatalogIds?: string[]
  requiresBranch?: boolean
  maxConcurrentDispatches?: number
  /** Corre igual aunque el issue esté bloqueado por otro (tolerancia de trabajo,
   *  no criterio de activación — por eso sobrevivió a la migración a Pipeline). */
  allowBlocked?: boolean
  /** Dueño de la fila para edición/visibilidad — NO es activación. */
  projectId?: string | null
  /** Orden en el editor, dentro de su ámbito — presentación, no criterio de match. */
  position?: number
  /** Contrato de `submit_output`, opt-in — vuelve obligatorio llamarlo antes de cerrar.
   *  Es lo que ESTE agente produce, no lo que espera recibir (ver `expectedInput`). */
  output?: AgentOutput
  /** Lo que ESTE agente espera recibir cuando lo alimenta el output de un paso
   *  anterior de la misma Pipeline — simétrico a `output`, pero mirando para
   *  el otro lado. `Pipeline.execute` lo resuelve para el paso anterior como
   *  `ctx.nextSchema` (mirando ESTE agente, no el propio): un agente A
   *  encadenado con un agente B tiene que producir lo que B `expectedInput`
   *  declara, no lo que B `output` declara — B.output es lo que B entrega al
   *  CERRAR, no lo que necesita para arrancar. Confundir los dos fue
   *  justamente el bug que esto corrige. */
  expectedInput?: AgentOutput
  /** Comandos que corre el ENGINE (no el modelo) en el worktree tras el loop. */
  verify?: string[]
  /** Hook: corre siempre al arrancar el run, no es una salida elegible. */
  onProcess?: string
  exits?: Record<string, AgentExit>
  /** Destino default de todos los comentarios de este agente. */
  comment?: CommentTarget
}

export interface AgentRunInput {
  /**
   * Bolsa de datos genérica — nunca una entidad con comportamiento propio.
   * Agent nunca sabe qué representa: un normalizador/triage
   * puede correr con esto ausente (todavía no hay nada, puede ser justo el
   * que lo va a CREAR emitiendo un evento derivado); cuando está presente,
   * `onStart`/`finalize` leen/escriben un par de claves por CONVENCIÓN
   * (`agentWorking`, `status`) — mutación de datos planos, no una llamada a
   * método sobre una instancia. `AgentAction` es quien la arma, típicamente
   * pasando `event.payload` tal cual: el mismo objeto que ya viaja como
   * transporte base de `DomainEvent`, no algo nuevo que Agent invente.
   */
  payload?: Record<string, unknown>
  /** Obligatorio cuando este Agent corre como sub-agente (run_agent en v1) —
   *  el hijo no hereda contexto del padre. */
  brief?: string
  /** Schema que el output ESTRUCTURADO de este run debería cumplir, cuando
   *  el próximo `do` de la cadena es un agente que lo necesita como input
   *  tipado (viaja desde PipelineExecutionContext.nextSchema). Ausente: el
   *  agente corre con su propio `output` declarado, sin hand-off. */
  expectedOutput?: AgentOutput
  /** `this.tools` ya filtrado contra `provider.kind` — lo agrega
   *  `Agent.execute()` antes de llamar a `provider.run()`; quien llama a
   *  `Agent.run()` desde afuera (AgentAction) no lo setea. El schema/
   *  ejecución de cada tool es responsabilidad del Provider; el dominio
   *  sólo garantiza que la combinación tool↔provider sea válida antes de
   *  que el Provider la vea. */
  tools?: AgentToolEntry[]
  /** Coordenadas de workspace (repos + branch + workflow), NO paths de una
   *  máquina — lo arma quien llama a `Agent.run()` (AgentAction, leyendo
   *  `event.scope`) porque `Agent` no conoce repos. `Agent.execute()` lo
   *  reenvía a `Provider.prepareWorkspace()` sólo si `this.requiresBranch`.
   *  Ausente ⇒ el agente corre sin worktree, con lo que el Provider ya
   *  resuelva por default. */
  workspace?: WorkspaceRequest
}

/**
 * Lo que un Provider necesita para poder correr, agregado por
 * `Agent.execute()` a partir de la propia definición del agente —
 * `AgentRunInput` es lo que un CALLER (AgentAction) sabe armar, esto es lo
 * que sólo `Agent` mismo puede resolver (su prompt, sus variables, sus MCP,
 * sus system prompts ya resueltos del catálogo). Separado de `AgentRunInput`
 * a propósito: ninguno de estos campos depende del evento que disparó el
 * run, todos salen de `AgentDefinitionProps`.
 */
export interface AgentRunContext extends AgentRunInput {
  agentId: string
  prompt: string
  variables: Record<string, AgentVariableValue>
  providerConfig: Record<string, unknown>
  /** System prompts ya resueltos a texto — una entrada con `id` sin `text`
   *  y sin catálogo se descarta en vez de fallar el run (mismo criterio
   *  fail-open que `Tool.supports`). */
  systemPrompts: string[]
  mcpServers: McpCatalogEntry[]
}

export interface AgentRunOutput {
  outcome: string
  exit?: AgentExit
  summary?: string
  /** Presente si `output` está declarado y el agente llamó a submit_output. */
  structuredOutput?: Record<string, unknown>
}

/**
 * Identidad + capacidad de un agente: qué tools tiene, con qué provider corre,
 * y cómo cierra (exits). NO sabe cuándo le toca correr — eso es 100% de
 * Pipeline.when/on (en v1 vivía en AgentActivationSchema; ver migración
 * 059-activation-into-rules). Un Agent se autoindexa por id y las Pipeline lo
 * referencian por ese id — nunca se embebe en una cadena de `do`.
 *
 * Se autoindexa igual que Execution/Project/PipelineActionEntry: antes vivía en
 * una `AgentRegistry` aparte, pero register/resolve/list/visibleTo son la
 * misma forma (Map + query) sin motivo para ser una segunda clase.
 */
export class Agent {
  private static readonly catalog = new Catalog<Agent>((a) => a.id)

  /** Rechaza id duplicado y valida que `exits` sea consistente (ninguna
   *  clave vacía, `output` declarado si alguna Pipeline espera
   *  `{{steps.<id>.output.<campo>}}`) — un exit mal formado tiene que fallar
   *  ACÁ, al registrar, no en cada matchExit() de cada run. */
  static register(agent: Agent): void {
    if (Agent.resolve(agent.id) != null) throw new Error(`Agent duplicado: ${agent.id}`)
    for (const [name, exit] of Object.entries(agent.exits)) {
      if (name.trim() === '') throw new Error(`Agent ${agent.id}: exit con clave vacía`)
      if (typeof exit === 'object' && exit.set.trim() === '') {
        throw new Error(`Agent ${agent.id}: exit "${name}" con set vacío`)
      }
    }
    Agent.catalog.register(agent)
  }

  static resolve(id: string): Agent | undefined {
    return Agent.catalog.resolve(id)
  }

  static list(): Agent[] {
    return Agent.catalog.list().sort((a, b) => a.position - b.position)
  }

  /** Agentes visibles desde un proyecto: los globales (`projectId: null`) + los propios. */
  static visibleTo(projectId: string | undefined): Agent[] {
    return Agent.list().filter((a) => a.projectId == null || a.projectId === projectId)
  }

  /** Sólo para tests — vacía el índice estático entre corridas aisladas. */
  static reset(): void {
    Agent.catalog.reset()
  }

  readonly id: string
  readonly provider: AgentProvider
  readonly prompt: string
  readonly systemPrompts: SystemPromptRef[]
  readonly variables: Record<string, AgentVariableValue>
  readonly tools: AgentToolEntry[]
  readonly saveOutput: boolean
  readonly providerConfig: Record<string, unknown>
  readonly mcpCatalogIds: string[]
  readonly requiresBranch?: boolean
  readonly maxConcurrentDispatches?: number
  readonly allowBlocked: boolean
  readonly projectId: string | null
  readonly position: number
  readonly output?: AgentOutput
  readonly expectedInput?: AgentOutput
  readonly verify: string[]
  readonly onProcess?: string
  readonly exits: Record<string, AgentExit>
  readonly comment?: CommentTarget

  constructor(props: AgentDefinitionProps) {
    this.id = props.id
    this.provider = props.provider
    this.prompt = props.prompt
    this.systemPrompts = props.systemPrompts ?? []
    this.variables = props.variables ?? {}
    this.tools = props.tools ?? []
    this.saveOutput = props.saveOutput ?? false
    this.providerConfig = props.providerConfig ?? {}
    this.mcpCatalogIds = props.mcpCatalogIds ?? []
    this.requiresBranch = props.requiresBranch
    this.maxConcurrentDispatches = props.maxConcurrentDispatches
    this.allowBlocked = props.allowBlocked ?? false
    this.projectId = props.projectId ?? null
    this.position = props.position ?? 0
    this.output = props.output
    this.expectedInput = props.expectedInput
    this.verify = props.verify ?? []
    this.onProcess = props.onProcess
    this.exits = props.exits ?? {}
    this.comment = props.comment
  }

  /**
   * onStart marca el issue como working ANTES de que exista ninguna forma de
   * revertir esa marca salvo terminar el run — así que todo lo que sigue va
   * en un try/catch que embudea cualquier falla (de execute, de verify, o un
   * throw inesperado) hacia finalize(ERROR_EXIT, ...) en vez de propagar y
   * dejar el issue trabado hasta el próximo crashRecovery. El error se le
   * pasa a finalize (no se descarta) para que el ExecutionLog y el comentario
   * de cierre puedan explicar POR QUÉ falló, no sólo que falló.
   */
  async run(input: AgentRunInput): Promise<AgentRunOutput> {
    const startedAt = new Date()
    await this.onStart(input.payload)
    let outcome: string
    let error: unknown
    let summary: string | undefined
    let structuredOutput: Record<string, unknown> | undefined
    try {
      const result = await this.execute(input)
      outcome = await this.verifyWorktree(input.payload, result.outcome, result.workspace)
      summary = result.summary
      structuredOutput = result.structuredOutput
    } catch (err) {
      outcome = ERROR_EXIT
      error = err
    }
    return this.finalize(outcome, input.payload, startedAt, error, summary, structuredOutput)
  }

  /** Sin `payload` no hay nada que marcar — un agente de triage/normalización
   *  que corre directo sobre un evento no tiene todavía nada que poner en
   *  working (puede ser justo el que lo va a CREAR). Con `payload`, marca
   *  la clave `agentWorking` por convención — dato plano, no una llamada a
   *  método; persistirlo en la fuente remota (setAgentWorking en v1) es un
   *  efecto de borde de un port que este esqueleto todavía no tiene. */
  protected async onStart(payload?: Record<string, unknown>): Promise<void> {
    if (payload != null) payload.agentWorking = true
  }

  /**
   * Resuelve el provider (this.provider — string directo, o desempate entre
   * AgentProviderChoice[]), pide admisión (Provider.canAccept), arma su
   * workspace (Provider.prepareWorkspace) y corre el loop de tools hasta
   * terminar o fallar. El `workspace` que devuelve es lo que verifyWorktree
   * necesita para saber DÓNDE correr `this.verify[]` — viaja como parte del
   * resultado en vez de que verifyWorktree tenga que resolverlo de nuevo.
   */
  protected async execute(input: AgentRunInput): Promise<{
    outcome: string
    workspace?: WorkspacePlan
    summary?: string
    structuredOutput?: Record<string, unknown>
  }> {
    const provider = await this.resolveProvider(input.payload ?? {})

    const admission = await provider.canAccept({
      agentId: this.id,
      running: Execution.runningForProvider(provider.id),
      cap: provider.maxConcurrentRuns,
    })
    if (!admission.accept) {
      throw new Error(
        `Agent ${this.id}: provider "${provider.id}" no admite el run` +
          (admission.reason != null ? ` (${admission.reason})` : ''),
      )
    }

    // Una tool que Tool.resolve() dice que no soporta provider.kind se
    // DESCARTA acá, no revienta el run — misma filosofía fail-open que
    // canAccept, y evita el bug de v1 de un agente que declara bash_run/fs_*
    // y corre en el disco equivocado.
    const tools = this.tools.filter((t) => {
      const name = typeof t === 'string' ? t : t.name
      const def = Tool.resolve(name)
      return def == null || def.supports(provider.kind)
    })

    const workspace =
      this.requiresBranch && input.workspace != null
        ? await provider.prepareWorkspace(input.workspace)
        : undefined

    const output = await provider.run({
      ...input,
      tools,
      agentId: this.id,
      prompt: this.prompt,
      variables: this.variables,
      providerConfig: this.providerConfig,
      systemPrompts: this.resolveSystemPrompts(),
      mcpServers: McpCatalogEntry.resolveAll(this.mcpCatalogIds),
    })
    return {
      outcome: output.outcome,
      workspace,
      summary: output.summary,
      structuredOutput: output.structuredOutput,
    }
  }

  /**
   * `this.provider` string ⇒ directo. Array ⇒ el primer candidato cuyo
   * when/whenText matchea, en el orden declarado (la prioridad ES el orden
   * del array). El desempate por clasificador cuando >1 candidato resuelve a
   * la vez (el `whenText` homónimo de `AgentProviderChoiceSchema` en v1) NO
   * está portado — hoy gana el primero que matchea, ambigüedad incluida; se
   * agrega el día que un caso real lo necesite, no antes.
   */
  private async resolveProvider(payload: Record<string, unknown>): Promise<Provider> {
    const providerId =
      typeof this.provider === 'string' ? this.provider : await this.pickProviderChoice(payload)
    const provider = Provider.resolve(providerId)
    if (provider == null) throw new Error(`Agent ${this.id}: provider desconocido "${providerId}"`)
    return provider
  }

  private async pickProviderChoice(payload: Record<string, unknown>): Promise<string> {
    const choices = this.provider as AgentProviderChoice[]
    for (const choice of choices) {
      if (await choice.matchesAllConditions(payload)) return choice.providerId
    }
    throw new Error(`Agent ${this.id}: ningún provider candidato matchea`)
  }

  /** Una entrada con `id` que no resuelve en el catálogo se descarta, no
   *  revienta el run — mismo criterio fail-open que el filtro de tools. */
  private resolveSystemPrompts(): string[] {
    return this.systemPrompts
      .map((ref) => ref.text ?? SystemPromptEntry.resolve(ref.id ?? '')?.text)
      .filter((text): text is string => text != null)
  }

  /**
   * Corre this.verify[] en el worktree DESPUÉS de execute y ANTES de finalize
   * — es lo único que puede todavía cambiar el outcome antes de que se
   * aplique una transición. Un exit != 0 devuelve ERROR_EXIT (failureClass
   * `verify_failed`) en vez del outcome recibido; no corre si outcome ya es
   * error/truncated/cancelled.
   *
   * Sin `payload`, sin `workspace` (el provider no dio uno — nada corrió en
   * disco) o sin `verify[]` declarado, no hay nada que verificar: se
   * devuelve `outcome` tal cual. `worktreePath` gana sobre `cwd` cuando el
   * Provider dio los dos (es el path más específico — ver WorkspacePlan).
   */
  protected async verifyWorktree(
    payload: Record<string, unknown> | undefined,
    outcome: string,
    workspace?: WorkspacePlan,
  ): Promise<string> {
    if (payload == null) return outcome
    if (this.verify.length === 0) return outcome
    if (outcome === ERROR_EXIT || NO_TRANSITION_OUTCOMES.includes(outcome as NoTransitionOutcome)) {
      return outcome
    }
    const cwd = workspace?.worktreePath ?? workspace?.cwd
    if (cwd == null) return outcome

    const runner = getShellRunner()
    if (runner == null) {
      throw new Error('Agent.verify necesita un ShellRunner — ver infra/ShellRunner.js (setShellRunner)')
    }
    for (const command of this.verify) {
      const result = await runner.run(command, [], { cwd })
      if (result.exitCode !== 0) return ERROR_EXIT
    }
    return outcome
  }

  /**
   * Matchea el outcome contra this.exits, aplica la transición y graba el
   * ExecutionLog. `error` viene seteado cuando run() capturó una falla de
   * execute/verify — su mensaje va al ExecutionLog y al comentario de cierre.
   * Tiene que ser resiliente (mismo motivo que safeUpdateLog/safeInsertLog en
   * execution-log.ts de v1): un fallo ACÁ no puede dejar agent_working=true
   * sin aplicar ningún exit, porque run() ya no tiene otro punto de recuperación.
   */
  protected async finalize(
    outcome: string,
    payload: Record<string, unknown> | undefined,
    startedAt: Date,
    error?: unknown,
    summary?: string,
    structuredOutput?: Record<string, unknown>,
  ): Promise<AgentRunOutput> {
    const exit = this.matchExit(outcome)
    if (payload != null) {
      payload.agentWorking = false
      const nextStatus = exitSet(exit)
      if (nextStatus != null) {
        payload.status = nextStatus
        await this.writeStatus(payload, nextStatus)
      }
      if (summary != null) await this.writeComment(payload, exit, summary)
    }
    const payloadId = typeof payload?.id === 'string' ? payload.id : undefined
    ExecutionLog.append(
      new ExecutionLog({
        id: crypto.randomUUID(),
        taskId: payloadId,
        agentId: this.id,
        outcome,
        exit,
        status: error != null ? 'failed' : 'completed',
        error: error != null ? String(error) : undefined,
        startedAt,
        finishedAt: new Date(),
      }),
    )
    return { outcome, exit, summary, structuredOutput }
  }

  /**
   * `payload.status` ya está mutado en memoria antes de esto — acá se hace
   * DURABLE, hacia la fuente remota que `payload` representa. Best-effort
   * a propósito, mismo criterio que "guardar el link del hilo de Slack es
   * best-effort" en v1: el ExecutionLog y el payload en memoria ya reflejan
   * qué pasó en ESTE dispatch; perder la persistencia remota es peor de
   * evitar, pero no puede tumbar un cierre que ya decidió su resultado. Sin
   * PayloadWriter seteado, no-op — es capacidad opt-in (ver PayloadWriter.js).
   */
  private async writeStatus(payload: Record<string, unknown>, status: string): Promise<void> {
    try {
      await getPayloadWriter()?.applyStatus(payload, status)
    } catch {
      // silencioso a propósito — ver doc de arriba.
    }
  }

  /** Mismo criterio best-effort que writeStatus. `target: 'none'` no llama
   *  al writer — evita que un Provider sin credenciales de comentario reciba
   *  una llamada que de todas formas iba a no-opear del otro lado. */
  private async writeComment(
    payload: Record<string, unknown>,
    exit: AgentExit | undefined,
    summary: string,
  ): Promise<void> {
    const target = resolveCommentTarget(exit, this.comment)
    if (target === 'none') return
    try {
      await getPayloadWriter()?.postComment(payload, target, summary)
    } catch {
      // silencioso a propósito — ver writeStatus.
    }
  }

  /**
   * Matchea un outcome (el que puso `execute`/`verifyWorktree`, o el `exit`
   * que el modelo eligió vía `select_exit`) contra `this.exits`.
   *
   * `cancelled`/`truncated` devuelven `undefined` A PROPÓSITO — no son un
   * fallo del agente, son el run cortado desde afuera (cancel manual,
   * upstream abort, límite de tool-use truncado). Aplicarles ERROR_EXIT
   * comentaría un fallo que no ocurrió y movería el issue a donde v1 mueve
   * un error real. `finalize` no aplica ninguna transición cuando esto
   * devuelve `undefined` — mismo comportamiento que Agent.ts en v1.
   *
   * Cualquier otro nombre que no está en `this.exits` cae a `ERROR_EXIT`: es
   * la red para un outcome desconocido, pero el nombre bien formado (que
   * venga de `select_exit`) tiene que validarse ANTES de esto —
   * `Agent.register` es donde correspondería rechazar un agente cuyo
   * `output`/exits declaran algo inconsistente, no acá en cada run.
   */
  matchExit(outcomeName: string): AgentExit | undefined {
    if (NO_TRANSITION_OUTCOMES.includes(outcomeName as NoTransitionOutcome)) return undefined
    return this.exits[outcomeName] ?? this.exits[ERROR_EXIT]
  }

  /** true si alguna tool declarada es de escritura, según el catálogo
   *  (`Tool.isWrite`). Una tool sin entrada en el catálogo se asume de
   *  sólo-lectura — sólo importa para decidir si intersectar writePaths
   *  contra el WorkspacePlan (ver AgentAction.run). */
  hasWriteTools(): boolean {
    return this.tools.some((t) => {
      const name = typeof t === 'string' ? t : t.name
      return Tool.resolve(name)?.isWrite ?? false
    })
  }

  /**
   * Traducción pura (sin I/O) de una fila de `AgentDefinitionSchema` (v1,
   * `packages/shared/src/schemas.ts`) a una instancia de `Agent`. Dos
   * desajustes reales entre los dos schemas:
   * - `save_output` (v1, snake_case) → `saveOutput` (v2, camelCase) — único
   *   nombre de campo que no coincide 1:1.
   * - `expectedInput` no existe en v1 — es un campo que esta sesión le
   *   agregó a v2 (ver el fix del bug de `Pipeline.execute`/`nextSchema`).
   *   Una fila de v1 simplemente no lo trae; queda `undefined` salvo que la
   *   fila ya lo incluya (compatibilidad hacia adelante, para cuando v1
   *   también lo declare).
   */
  static fromRow(row: AgentRow): Agent {
    return new Agent({
      id: row.id,
      provider: row.provider,
      prompt: row.prompt,
      systemPrompts: row.systemPrompts,
      variables: row.variables,
      tools: row.tools,
      saveOutput: row.save_output,
      providerConfig: row.providerConfig,
      mcpCatalogIds: row.mcpCatalogIds,
      requiresBranch: row.requiresBranch,
      maxConcurrentDispatches: row.maxConcurrentDispatches,
      allowBlocked: row.allowBlocked,
      projectId: row.projectId,
      position: row.position,
      output: row.output,
      expectedInput: row.expectedInput,
      verify: row.verify,
      onProcess: row.onProcess,
      exits: row.exits,
      comment: row.comment,
    })
  }
}

/** Fila cruda de `AgentDefinitionSchema` (v1) — mismos nombres de campo que
 *  `AgentDefinitionProps`, salvo `save_output` (ver `Agent.fromRow`). */
export interface AgentRow extends Omit<AgentDefinitionProps, 'saveOutput'> {
  save_output?: boolean
}
