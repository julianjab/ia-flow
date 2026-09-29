/**
 * Un gate semántico (`whenText`): un modelo lee el evento y dice si cumple un criterio escrito en
 * lenguaje natural. Es impuro (una llamada a un modelo) y por eso vive APARTE del `when`: se
 * evalúa después de él, sólo si las condiciones puras ya pasaron.
 */
export interface WhenText {
  /** El criterio: qué tiene que cumplir el evento para que esto corra. */
  text: string
  /** Instrucciones para el clasificador, ya resueltas a texto (el YAML las nombra por id). */
  systemPrompts?: string[]
  /** Default: el del clasificador. */
  model?: string
}

/** `matches: null` = no pudo decidir (sin clasificador, sin credencial, error, sin veredicto):
 *  lo que tiene el gate NO corre, igual que si dijera que no — nunca se adivina. */
export interface TextVerdict {
  matches: boolean | null
  reason: string
}

export interface TextClassifier {
  classify(request: { whenText: WhenText; subject: Record<string, unknown> }): Promise<TextVerdict>
}
