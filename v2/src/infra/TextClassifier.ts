/**
 * El gate impuro de `Conditional.whenText` — un clasificador tipo Haiku que
 * lee el payload y dice si cumple la condición semántica descrita en texto
 * libre. Sin esto, `whenText` no se puede evaluar (a diferencia de `when`,
 * que es `Condition[]` puro y ya corre sin ningún port).
 */
export interface TextClassifier {
  classify(whenText: string, payload: Record<string, unknown>): Promise<boolean>
}

let current: TextClassifier | undefined

export function setTextClassifier(classifier: TextClassifier | undefined): void {
  current = classifier
}

export function getTextClassifier(): TextClassifier | undefined {
  return current
}
