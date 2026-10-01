/**
 * Errores con detalle para trazas y logs. Un `AggregateError` (varias pipelines fallaron, un
 * `Promise.allSettled`) o un error con `cause` esconde la causa real detrás de un mensaje genérico
 * — acá se aplanan a una lista para que ninguna se pierda.
 */
/** Un error de la cadena, con dónde cuelga (`errors[0].cause`, …) para ubicarlo. */
export interface ErrorDetail {
  /** Ruta desde el error raíz: `''` el raíz, `errors[1]`, `errors[1].cause`… */
  path: string
  type: string
  message: string
  stack?: string
}

/** Tope de profundidad: un ciclo de `cause` no cuelga el aplanado. */
const MAX_DEPTH = 8

/** El error y todos los que cuelgan de él (`AggregateError.errors`, `cause`), raíz primero. */
export function flattenError(err: unknown, path = '', depth = 0): ErrorDetail[] {
  const detail: ErrorDetail =
    err instanceof Error
      ? {
          path,
          type: err.name,
          message: err.message,
          ...(err.stack ? { stack: err.stack } : {}),
        }
      : { path, type: typeof err, message: String(err) }
  if (depth >= MAX_DEPTH || !(err instanceof Error)) return [detail]
  const nested: ErrorDetail[] = []
  if (err instanceof AggregateError) {
    err.errors.forEach((inner, i) => {
      nested.push(...flattenError(inner, `${path}errors[${i}]`, depth + 1))
    })
  }
  if (err.cause !== undefined) {
    nested.push(...flattenError(err.cause, `${path}${path ? '.' : ''}cause`, depth + 1))
  }
  return [detail, ...nested]
}

/** Una línea legible: el mensaje del error y, entre corchetes, el de cada causa. */
export function describeError(err: unknown): string {
  const [root, ...causes] = flattenError(err)
  if (!root) return String(err)
  if (causes.length === 0) return root.message
  return `${root.message} [${causes.map((c) => `${c.path}: ${c.type}: ${c.message}`).join(' | ')}]`
}
