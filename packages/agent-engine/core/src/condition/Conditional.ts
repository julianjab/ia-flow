import { Condition } from './Condition.js'
import type { TextClassifier, TextVerdict, WhenText } from './TextClassifier.js'

export interface ConditionalProps {
  when?: Condition[]
  /** El gate semántico: un modelo decide si el evento cumple el criterio. Lo evalúan el planner
   *  (el de una pipeline) y el `StepRunner` (el de un paso), después del `when`. */
  whenText?: WhenText
}

/** El veredicto, sin tirar nunca: un clasificador que falla es uno que no pudo decidir — ni
 *  tumba el despacho de las demás pipelines ni se saltea el manejo de errores de un paso. */
async function classify(
  classifier: TextClassifier,
  whenText: WhenText,
  subject: Record<string, unknown>,
): Promise<TextVerdict> {
  try {
    return await classifier.classify({ whenText, subject })
  } catch (error) {
    return { matches: null, reason: `el clasificador falló: ${(error as Error).message}` }
  }
}

/** Un veredicto por (evento, criterio): el planner y los pasos que preguntan lo mismo sobre el
 *  mismo evento hacen UNA llamada. `WeakMap` sobre el evento: muere con él. */
const verdicts = new WeakMap<object, Map<string, Promise<TextVerdict>>>()

/**
 * Base para cualquier entidad que matchea contra un `when` — antes de esto, `Pipeline` y
 * `Runnable` reimplementaban CADA UNA el mismo loop de encadenado and/or (`Condition.evaluateAll`
 * ya lo hacía; el `Runnable` de esa época lo copiaba a mano). Ahora las dos delegan en
 * `matchesConditions`, así que el algoritmo vive en un solo lugar — `Condition.evaluateAll` —
 * y esta clase sólo lo expone. Lo que SÍ varía por subclase es qué arman como `subject`:
 * `Pipeline` evalúa contra el payload crudo del evento; `Runnable` le agrega `steps` antes de
 * evaluar (ver su propio `shouldRun`).
 */
export abstract class Conditional {
  readonly when: Condition[]
  readonly whenText?: WhenText

  constructor(props: ConditionalProps) {
    this.when = props.when ?? []
    if (props.whenText) this.whenText = props.whenText
  }

  matchesConditions(subject: unknown): boolean {
    return Condition.evaluateAll(this.when, subject)
  }

  /** Por qué `subject` no cumple el `when` (las condiciones que dan false, con lo que vino), o
   *  `undefined` si lo cumple — lo que queda en la traza cuando algo no corrió. */
  explainConditions(subject: unknown): string | undefined {
    if (this.matchesConditions(subject)) return undefined
    const failed = this.when.filter((condition) => !condition.evaluate(subject))
    return `no cumple: ${failed.map((condition) => condition.describe(subject)).join('; ')}`
  }

  /**
   * Por qué el `whenText` no deja pasar (lo que dijo el clasificador), o `undefined` si pasa o no
   * hay. Sin clasificador, o sin veredicto, NO pasa: nunca se adivina. `key` es el objeto al que
   * se ata la cache — el evento.
   */
  async explainText(
    subject: Record<string, unknown>,
    classifier: TextClassifier | undefined,
    key: object,
  ): Promise<string | undefined> {
    const whenText = this.whenText
    if (!whenText) return undefined
    if (!classifier) return 'whenText sin clasificador: no corre'
    const criterion = JSON.stringify(whenText)
    const cached = verdicts.get(key) ?? new Map<string, Promise<TextVerdict>>()
    verdicts.set(key, cached)
    let pending = cached.get(criterion)
    if (!pending) {
      pending = classify(classifier, whenText, subject)
      cached.set(criterion, pending)
    }
    const verdict = await pending
    // Sólo un sí o un no queda: un "no pude decidir" (timeout, 429) se vuelve a preguntar.
    if (verdict.matches === null && cached.get(criterion) === pending) cached.delete(criterion)
    if (verdict.matches === true) return undefined
    return verdict.matches === false
      ? `whenText: no — ${verdict.reason}`
      : `whenText sin veredicto — ${verdict.reason}`
  }
}
