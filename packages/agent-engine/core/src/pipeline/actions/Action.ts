import { z } from 'zod'
import type { Tool, ToolOrigin } from '../../agent/AgentDefinition.js'
import type { ToolInputSchema } from '../../agent/SchemaTool.js'
import { type PipelineExecutionContext, Runnable, type RunnableProps } from '../Runnable.js'
import { ActionTool } from './ActionTool.js'

/** `none`: sólo lee. `write`: cambia algo afuera (un issue, un POST, un archivo). */
export type SideEffects = 'none' | 'write'

export interface ActionProps extends RunnableProps {
  /** Obligatorio, a diferencia de un `Runnable` genérico: es el nombre de la tool cuando la
   *  acción se le da a un agente, y la clave de su input en un `submit_<salida>`. */
  id: string
}

// Mismo formato que exige la API de Anthropic para el nombre de una tool.
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/

/**
 * Una unidad de trabajo con input TIPADO: declara `input` (un `z.strictObject`) y lo que hace
 * con él en `execute`. Sirve para dos cosas sin duplicar nada:
 *
 * - **Paso de pipeline** (es un `Runnable`): va en `Pipeline.do[]` o como destino de una ruta.
 *   Su input llega validado contra `input` — el que arma el agente en `submit_<salida>`, o `{}`.
 * - **Tool de un agente** (`asTool(ctx)`): el modelo la llama con el mismo schema.
 *
 * `sideEffects` default `'write'` a propósito: una acción que no declara que sólo lee se trata
 * como una que escribe, y un agente no la recibe como tool salvo que se la habilite explícito
 * con `allowWrite()` (ver `AgentDefinitionProps.actions`).
 */
export abstract class Action<
  S extends ToolInputSchema = ToolInputSchema,
  O = unknown,
> extends Runnable {
  declare readonly id: string
  abstract readonly description: string
  abstract readonly input: S
  readonly sideEffects: SideEffects = 'write'
  /** Opera sobre el worktree de la task: como tool, no se le ofrece a un provider con workspace
   *  nativo (ver `Tool.workspace`). */
  readonly workspace: boolean = false
  /** Con qué se armó (la definición y sus `options` del YAML), si quien la armó lo dejó anotado:
   *  lo que necesita otro proceso para rearmarla igual sobre SU worktree (ver `Tool.origin`). */
  origin?: ToolOrigin

  constructor(props: ActionProps) {
    super(props)
    if (!TOOL_NAME.test(props.id)) {
      throw new Error(
        `Action: id "${props.id}" inválido — sólo letras, dígitos, "_" y "-" (máx. 64), porque también es el nombre de la tool`,
      )
    }
  }

  abstract execute(input: z.infer<S>, ctx: PipelineExecutionContext): Promise<O> | O

  override acceptsInput(): ToolInputSchema {
    return this.input
  }

  async run(ctx: PipelineExecutionContext, input?: unknown): Promise<O> {
    const parsed = this.input.safeParse(input ?? {})
    if (!parsed.success) {
      throw new Error(`${this.id}: input inválido\n${z.prettifyError(parsed.error)}`)
    }
    return this.execute(parsed.data, ctx)
  }

  /**
   * Fija campos del input desde la configuración — el operador decide, el modelo no. Los campos
   * fijados desaparecen del schema que ve el agente: `updateIssue.bind({ status: 'Build' })`
   * deja al modelo completar sólo lo que queda (ej. `labels`), nunca elegir el status.
   */
  bind(fixed: Partial<z.infer<S>>): BoundAction {
    return new BoundAction(this, fixed as Record<string, unknown>)
  }

  /** La acción como tool de un agente, con `ctx` capturado para cuando el modelo la llame. */
  asTool(ctx: PipelineExecutionContext): Tool {
    return new ActionTool(this, ctx)
  }

  /** Marca explícita de que un agente puede recibir esta acción como tool aunque escriba. */
  allowWrite(): AllowedAction {
    return new AllowedAction(this)
  }
}

/** Resultado de `action.allowWrite()` — lo único que `AgentDefinitionProps.actions` acepta para
 *  una acción con `sideEffects: 'write'`. */
export class AllowedAction {
  constructor(readonly action: Action) {}
}

/**
 * Una `Action` con campos del input ya fijados — ver `Action.bind`. Vive en este archivo y no en
 * uno propio a propósito: extiende `Action` y `Action.bind` la construye, y en ESM ese ciclo entre
 * dos módulos rompe (TDZ) según cuál se cargue primero.
 */
export class BoundAction extends Action {
  readonly description: string
  readonly input: ToolInputSchema
  override readonly sideEffects: SideEffects
  override readonly workspace: boolean

  constructor(
    readonly target: Action,
    readonly fixed: Record<string, unknown>,
  ) {
    super({ id: target.id, when: target.when, continueOnError: target.continueOnError })
    const keys = Object.keys(fixed)
    const unknown = keys.filter((key) => !(key in target.input.shape))
    if (unknown.length > 0) {
      throw new Error(`${target.id}.bind: campos que el input no declara: ${unknown.join(', ')}`)
    }
    const mask = Object.fromEntries(keys.map((key) => [key, true as const]))
    const check = target.input.pick(mask).safeParse(fixed)
    if (!check.success) {
      throw new Error(`${target.id}.bind: valores inválidos\n${z.prettifyError(check.error)}`)
    }
    this.description = target.description
    this.input = target.input.omit(mask) as unknown as ToolInputSchema
    this.sideEffects = target.sideEffects
    this.workspace = target.workspace
  }

  execute(input: Record<string, unknown>, ctx: PipelineExecutionContext): Promise<unknown> {
    return this.target.run(ctx, { ...input, ...this.fixed })
  }
}
