// Registry de acciones — mismo patrón que el de tools (`packages/tools/src/
// engine.ts`): un Map poblado por registración explícita, con una resolución
// que valida en el borde antes de ejecutar.
//
// La diferencia con las tools es de quién decide: una tool la elige el MODELO
// en medio de un run; una acción la elige el OPERADOR al escribir una regla.
// Por eso acá no hay policy ni allow-list — el borde de confianza es el CRUD de
// reglas, no el runtime.
import type { EngineEvent, Rule, RuleAction, RuleActionEntry } from '@ia-flow/shared'
import type { ZodTypeAny } from 'zod'

export interface ActionContext {
  event: EngineEvent
  rule: Rule
  /**
   * Índice de esta acción dentro del `do[]` de la regla.
   *
   * Es lo que permite que la fila de una acción diga en qué lugar de la
   * secuencia corrió. La acción `agent` además lo baja hasta la fila del run,
   * que si no empataría en 0 con la primera acción y volvería ambiguo el orden
   * del grupo en la UI.
   */
  position: number
  /** Publica un evento derivado. Hereda `causationId` y `depth+1`, que es lo
   *  que permite que el tope del bus corte un ciclo de reglas. */
  emit(type: string, payload?: Record<string, unknown>, scope?: EngineEvent['scope']): Promise<void>
}

export interface ActionResult {
  ok: boolean
  /** Resumen corto para el log y para la fila de `action_runs`. */
  detail?: string
  /** Hubo trabajo pero no capacidad. Se propaga como `deferred` para que el
   *  item vuelva al backlog en vez de perderse. */
  deferred?: boolean
  /**
   * No había nada que hacer. **No es un fallo, y no corta el `do[]`.**
   *
   * La distinción es la misma que `DispatchOutcome` ya hace entre `skipped` y
   * `deferred`, y hace falta por lo mismo: sin ella, "esto no aplica" y "esto
   * se rompió" comparten el único canal que hay (`ok: false`), y el runner
   * —que no puede distinguirlos— aborta las acciones siguientes y graba la
   * fila en rojo.
   *
   * El caso concreto: un `ci.finished` de un PR que ningún issue del board
   * linkea. No hay agente que correr y eso es correcto, pero una regla
   * `do: [agent, emit]` perdía el `emit` y aparecía como fallada.
   */
  skipped?: boolean
}

export interface ActionHandler<C = unknown> {
  readonly kind: string
  /**
   * Valida la config de la acción tal como quedó guardada en la regla. Corre
   * en el CRUD (para no aceptar una regla imposible) y otra vez al ejecutar
   * (porque la fila pudo escribirse por otro camino).
   *
   * `ZodTypeAny` y no `ZodType<C>`: un schema con `.default()` —como el
   * `method` de la acción http— tiene tipos de entrada y salida distintos, y
   * `ZodType<C>` los fuerza iguales. La verificación real es de runtime
   * (`safeParse` antes de cada ejecución), así que atar el genérico acá daría
   * una garantía de compilación que igual no cubre el caso que importa: una
   * fila escrita por fuera del CRUD.
   */
  readonly configSchema: ZodTypeAny
  execute(ctx: ActionContext, config: C): Promise<ActionResult>
}

const registry = new Map<string, ActionHandler<never>>()

export function registerAction<C>(handler: ActionHandler<C>): void {
  registry.set(handler.kind, handler as unknown as ActionHandler<never>)
}

export function getActionHandler(kind: string): ActionHandler<never> | undefined {
  return registry.get(kind)
}

export function registeredActionKinds(): string[] {
  return [...registry.keys()].sort()
}

/** Sólo para tests: deja el registry como estaba. */
export function clearActionRegistry(): void {
  registry.clear()
}

export interface ActionValidationError {
  position: number
  kind: string
  message: string
}

/**
 * Valida el `do[]` de una regla contra los handlers registrados.
 *
 * Se llama desde el CRUD para que una regla que referencia una acción
 * inexistente falle al guardarse y no en el primer evento — un dispatch que no
 * corre porque la config estaba mal es el modo de falla más caro de este
 * sistema, porque es silencioso.
 */
export function validateActions(actions: readonly RuleActionEntry[]): ActionValidationError[] {
  const errors: ActionValidationError[] = []
  actions.forEach((entry, position) => {
    const kind = (entry as RuleAction).action

    // `ref` no tiene handler y no debería tenerlo: se resuelve ANTES del
    // dispatch (ver `runRule`), y para cuando el registry entra en juego ya es
    // la acción referenciada. Acá sólo se comprueba su forma; que el id exista
    // lo valida el CRUD, que es el único que sabe contra qué ámbito mirar.
    if (kind === 'ref') {
      const actionId = (entry as { actionId?: unknown }).actionId
      if (typeof actionId !== 'string' || !actionId.trim()) {
        errors.push({ position, kind, message: 'actionId es obligatorio' })
      }
      return
    }

    const handler = registry.get(kind)
    if (!handler) {
      errors.push({ position, kind, message: `acción desconocida: ${kind}` })
      return
    }
    const parsed = handler.configSchema.safeParse(entry)
    if (!parsed.success) {
      errors.push({
        position,
        kind,
        message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      })
    }
  })
  return errors
}
