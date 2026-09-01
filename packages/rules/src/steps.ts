// `{{steps.<paso>.output…}}` — el dato que viaja de una acción a la siguiente.
//
// Convierte el `do[]` de una lista de acciones independientes en un pipeline:
// un triager escribe el encargo y el paso siguiente lo recibe como `brief`, un
// script devuelve un valor y el `http` de abajo lo manda. Sin esto la única
// forma de pasar algo era el bus (`emit`), que re-matchea reglas y pierde el
// hilo de la secuencia.
//
// Es puro y no sabe de acciones: recibe la config cruda y el mapa de pasos, y
// devuelve la config resuelta o los motivos por los que no se pudo.
import type { RuleActionKind } from '@ia-flow/shared'

/** Lo que un paso dejó para los que siguen. */
export interface StepOutput {
  /** El valor. Un agente sin contrato de salida deja su texto final; con
   *  contrato, el objeto que entregó por `submit_output`. */
  output: unknown
  /** Qué tipo de acción lo produjo. NO es telemetría: decide si el valor puede
   *  entrar en un campo que elige qué se ejecuta — ver `EXECUTION_FIELDS`. */
  from: RuleActionKind
}

export type Steps = Record<string, StepOutput>

/**
 * Campos que deciden QUÉ se ejecuta o ADÓNDE se manda, no qué dice.
 *
 * Un valor producido por un AGENTE no puede entrar acá. El resto de los
 * campos sí: `brief`, `body`, `payload` son contenido, y meter texto de un
 * modelo en el prompt del siguiente es exactamente lo que esta feature existe
 * para permitir.
 *
 * La distinción no es "campo de contenido vs. campo de ruteo" —`http` ya
 * interpola `{{event.*}}` en su `url` desde siempre— sino la FUENTE: un
 * `{{event.*}}` es config del operador atravesando un webhook firmado; un
 * `{{steps.<agente>.output}}` es texto libre que un modelo escribió recién. Un
 * modelo eligiendo el `agentId` del próximo run elige su prompt, sus tools, su
 * policy de bash y su provider; eligiendo una `url` con `${SECRETO}` en el
 * body, elige adónde sale un token.
 *
 * Para que un modelo decida entre varios destinos, el camino es el que el
 * sistema ya usa en `select_exit`: el operador declara el espacio y el modelo
 * elige adentro.
 */
const EXECUTION_FIELDS = new Set([
  'agentId',
  'actionId',
  'file',
  'runtime',
  'url',
  'method',
  // La lista de destinos es la compuerta MISMA. Si pudiera salir de un agente,
  // el mismo modelo escribiría la elección y el espacio de elecciones, y
  // "el operador declara el espacio" dejaría de significar nada.
  'allowAgents',
])

/**
 * El único campo de ejecución que un agente SÍ puede alimentar, y con qué
 * condición: que la acción declare la lista de destinos posibles.
 *
 * Es el patrón que el sistema ya usa en `select_exit` y en el `enum` de un
 * campo de `output` — **el operador declara el espacio, el modelo elige
 * adentro**. Con la lista, un agente puede despachar al siguiente sin poder
 * inventar a quién: el peor caso es un agente del conjunto que el operador ya
 * consideró aceptable.
 *
 * Los demás campos de `EXECUTION_FIELDS` no tienen compuerta porque no tienen
 * un espacio enumerable que valga la pena: una `url` o un `file` de una lista
 * blanca ya se escriben directo, sin pasar por un modelo.
 */
const EXECUTION_FIELD_GATES: Record<string, string> = { agentId: 'allowAgents' }

/**
 * Si la config abrió la compuerta de ese campo declarando su lista.
 *
 * La lista tiene que ser LITERAL. Un `allowAgents: ['{{steps.x.output.quien}}']`
 * es un array no vacío y abriría la compuerta, pero lo escribiría el mismo
 * modelo que después elige adentro — o sea que la compuerta se abriría a sí
 * misma. `EXECUTION_FIELDS` ya impide que un AGENTE la alimente; esto cubre
 * además el caso de un script, donde el valor no es peligroso pero la lista
 * dejaría de ser una decisión del operador tomada por adelantado.
 */
function isGated(config: unknown, field: string): boolean {
  const gate = EXECUTION_FIELD_GATES[field]
  if (!gate) return false
  const list = (config as Record<string, unknown> | null)?.[gate]
  if (!Array.isArray(list) || list.length === 0) return false
  return list.every((v) => typeof v === 'string' && !v.includes('{{steps.'))
}

/** `{{steps.a.output.b}}` — con o sin espacios adentro de las llaves. */
const STEP_REF = /\{\{\s*steps\.([^}\s]+)\s*\}\}/g
/** La misma, anclada: el string ENTERO es una sola referencia. */
const WHOLE_STEP_REF = /^\{\{\s*steps\.([^}\s]+)\s*\}\}$/

export interface ResolveStepsResult {
  value: unknown
  errors: string[]
  /** Los pasos cuyo valor terminó usándose, con quién lo produjo. Lo lee el
   *  runner para que una acción sepa si lo que recibió lo escribió un MODELO —
   *  ver `ActionContext.fromAgents`. */
  used: Array<{ id: string; from: RuleActionKind }>
}

/**
 * Resuelve las referencias a pasos anteriores dentro de la config de una acción.
 *
 * Corre ANTES del `safeParse` del handler, y es a propósito: así el schema
 * sigue siendo estricto (`method` sigue siendo un enum, no `string | plantilla`)
 * y lo que se valida es el valor ya resuelto. Un valor que no satisface el
 * schema falla la acción con el error del schema, que es el mensaje correcto.
 *
 * **Una referencia que no resuelve es un ERROR, no un hueco.** En el prompt de
 * un agente una variable desconocida se deja literal, porque ahí el costo es
 * que el modelo lea `{{task.foo}}`; acá el costo es un paso corriendo con un
 * encargo mutilado y nadie enterándose. Es el modo de falla que este sistema
 * tiene que dejar de tener.
 */
export function resolveSteps(config: unknown, steps: Steps): ResolveStepsResult {
  const errors: string[] = []
  const used = new Map<string, RuleActionKind>()

  const walk = (value: unknown, field?: string): unknown => {
    if (typeof value === 'string') return resolveString(value, field)
    if (Array.isArray(value)) return value.map((v) => walk(v, field))
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = walk(v, k)
      return out
    }
    return value
  }

  const resolveString = (str: string, field?: string): unknown => {
    // El string ENTERO es una referencia: se devuelve el valor con su tipo
    // nativo. Sin esto un `prNumber: '{{steps.x.output.n}}'` llegaría como
    // string al schema, que espera un número, y fallaría por una razón que no
    // tiene nada que ver con lo que el operador escribió.
    const whole = str.match(WHOLE_STEP_REF)
    if (whole) return lookup(whole[1], field)

    if (!STEP_REF.test(str)) {
      STEP_REF.lastIndex = 0
      return str
    }
    STEP_REF.lastIndex = 0
    // Interpolación dentro de un texto más grande: acá sí se convierte a
    // string, porque el resultado es un string.
    return str.replace(STEP_REF, (match, path: string) => {
      const resolved = lookup(path, field)
      if (resolved === undefined) return match
      return typeof resolved === 'string' ? resolved : JSON.stringify(resolved)
    })
  }

  const lookup = (path: string, field?: string): unknown => {
    const [stepId, ...rest] = path.split('.')
    const step = steps[stepId]
    if (!step) {
      errors.push(
        `'{{steps.${path}}}' apunta al paso '${stepId}', que no corrió antes en esta regla` +
          (Object.keys(steps).length
            ? ` (hay: ${Object.keys(steps).join(', ')})`
            : ' (no hay ninguno)'),
      )
      return undefined
    }
    if (field && EXECUTION_FIELDS.has(field) && step.from === 'agent' && !isGated(config, field)) {
      const gate = EXECUTION_FIELD_GATES[field]
      errors.push(
        `'${field}' no puede salir de un agente ('${stepId}'): ese campo decide qué se ejecuta ` +
          'o adónde se manda, y el valor lo escribió un modelo' +
          (gate ? `. Declarando \`${gate}\` con los destinos posibles, sí puede` : ''),
      )
      return undefined
    }
    used.set(stepId, step.from)

    let current: unknown = { output: step.output }
    for (const segment of rest) {
      if (current == null || typeof current !== 'object') {
        errors.push(`'{{steps.${path}}}' no existe: '${segment}' no cuelga de nada`)
        return undefined
      }
      current = (current as Record<string, unknown>)[segment]
    }
    if (current === undefined) {
      errors.push(`'{{steps.${path}}}' no existe en lo que dejó el paso '${stepId}'`)
      return undefined
    }
    return current
  }

  const value = walk(config)
  return { value, errors, used: [...used].map(([id, from]) => ({ id, from })) }
}

/** Si una config referencia algún paso. Evita recorrerla entera cuando no hay
 *  nada que resolver, que es el caso de casi toda regla. */
export function referencesSteps(config: unknown): boolean {
  // `?? false`: `JSON.stringify` devuelve `undefined` para un `undefined`
  // suelto, y el optional chaining lo propaga.
  return JSON.stringify(config)?.includes('{{steps.') ?? false
}
