/**
 * Instrumentación con OpenTelemetry — sólo contra las APIs (`@opentelemetry/api`,
 * `@opentelemetry/api-logs`), nunca contra un SDK: sin un SDK registrado por la app, cada span y
 * cada log es un no-op sin costo. Es el patrón estándar para librerías: la app decide si exporta,
 * a dónde (OTLP → Collector, Grafana, Datadog) y con qué sampling.
 *
 * Los atributos heredados (`withInheritedAttributes`, el `inherit` de `@traced`) llegan a cada
 * span y log creado debajo — en cualquier paquete — como `ia.<clave>` (`ia.projectId`, `ia.repo`,
 * `ia.issue`, …), así se filtra por cualquiera en el backend sin que cada paso tenga que acordarse
 * de etiquetar. Viajan en el `Context` de OTel (una clave propia, no baggage: el baggage se
 * propaga en los headers HTTP salientes y le mandaría el issue a terceros).
 *
 * El código instrumentado no toca spans: declara la traza con `@traced` (abre un span) o
 * `@tagged` (le suma al span activo) sobre el método, y lo que se registra vive en un
 * `tracing.ts` al lado del módulo.
 */
import {
  type Attributes,
  type AttributeValue,
  type Context,
  context,
  createContextKey,
  type Link,
  ROOT_CONTEXT,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api'
import type { Logger } from './logging.js'

/** El instrumentation scope por defecto — cada paquete debería pasar el suyo (`scope`). */
export const INSTRUMENTATION_SCOPE = '@ia-flow/telemetry'

const tracer = trace.getTracer(INSTRUMENTATION_SCOPE)
const SCOPE_KEY = createContextKey('ia-tools.scope-attributes')

/** Tope de un atributo con contenido libre (inputs, outputs, texto del modelo). */
export const MAX_ATTRIBUTE_LENGTH = 4000

/** `value` como string acotado — lo que va a un atributo de span o log. */
export function truncate(value: unknown, max = MAX_ATTRIBUTE_LENGTH): string {
  let text: string
  if (typeof value === 'string') text = value
  else {
    try {
      text = JSON.stringify(value) ?? String(value)
    } catch {
      text = String(value)
    }
  }
  return text.length > max ? `${text.slice(0, max)}… (+${text.length - max})` : text
}

function toAttribute(value: unknown): AttributeValue | undefined {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value as string[]
  return undefined
}

/** El scope de un evento como atributos `ia.<clave>`. Sólo valores primitivos (o listas de
 *  strings): un objeto anidado no es filtrable en ningún backend. */
export function scopeAttributes(scope: Record<string, unknown> | undefined): Attributes {
  const attributes: Attributes = {}
  for (const [key, value] of Object.entries(scope ?? {})) {
    const attribute = toAttribute(value)
    if (attribute !== undefined) attributes[`ia.${key}`] = attribute
  }
  return attributes
}

/** Los atributos heredados en el contexto activo — el scope del evento y lo que se sumó abajo
 *  (ej. `ia.pipeline.id`). */
export function inheritedAttributes(ctx: Context = context.active()): Attributes {
  return (ctx.getValue(SCOPE_KEY) as Attributes | undefined) ?? {}
}

/** Corre `fn` con `attributes` sumados a los heredados: todo span y log creado adentro —en este
 *  paquete, en un provider, en una tool— los lleva. */
export function withInheritedAttributes<T>(attributes: Attributes, fn: () => T): T {
  const merged = { ...inheritedAttributes(), ...attributes }
  return context.with(context.active().setValue(SCOPE_KEY, merged), fn)
}

/** Un enlace a otro span (de esta u otra traza): "esto pasó por causa de aquello", sin ser su
 *  hijo. Se captura con `captureSpanLink` y se pasa en `links`. */
export type SpanLink = Link

/** El span activo como enlace, para citarlo desde un span que se abre después en otra traza. Sin
 *  span activo, `undefined`. */
export function captureSpanLink(): SpanLink | undefined {
  const span = trace.getActiveSpan()
  return span ? { context: span.spanContext() } : undefined
}

/**
 * Corre `fn` sin span activo ni atributos heredados: lo que abra ahí empieza una traza nueva. Para
 * trabajo que se dispara DESDE un span pero no es parte de él (ej. un evento que se vuelve a
 * despachar al cerrar la corrida que lo tenía); con `links` se cita de dónde vino.
 */
export function inFreshContext<T>(fn: () => T): T {
  return context.with(ROOT_CONTEXT, fn)
}

export interface SpanOptions {
  kind?: SpanKind
  /** Spans (de otras trazas) que causaron este. */
  links?: SpanLink[]
  /** Instrumentation scope propio, para instrumentar desde otro paquete (un provider). */
  scope?: string
}

/**
 * Corre `fn` dentro de un span activo, con los atributos heredados + `attributes`. Si `fn` tira,
 * el span queda en ERROR con la excepción registrada, y el error se re-lanza tal cual.
 */
export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
  options: SpanOptions = {},
): Promise<T> {
  const spanTracer = options.scope ? trace.getTracer(options.scope) : tracer
  return spanTracer.startActiveSpan(
    name,
    {
      kind: options.kind ?? SpanKind.INTERNAL,
      attributes: { ...inheritedAttributes(), ...attributes },
      ...(options.links?.length ? { links: options.links } : {}),
    },
    async (span) => {
      try {
        return await fn(span)
      } catch (err) {
        markError(span, err)
        throw err
      } finally {
        span.end()
      }
    },
  )
}

/** El contexto activo (con su span), para colgar de él trabajo que llega después por otro
 *  camino — ej. los hooks de un CLI que reportan sus tools por HTTP mientras el agente corre. */
export function captureContext(): Context {
  return context.active()
}

/**
 * Abre un span que se cierra en otro momento (`span.end()`), colgado de `parent` en vez del
 * contexto activo: para lo que empieza y termina en llamadas separadas (un `PreToolUse` y su
 * `PostToolUse`). Lleva los atributos heredados de `parent`.
 */
export function startSpan(
  name: string,
  attributes: Attributes,
  options: SpanOptions & { parent?: Context } = {},
): Span {
  const parent = options.parent ?? context.active()
  const spanTracer = options.scope ? trace.getTracer(options.scope) : tracer
  return spanTracer.startSpan(
    name,
    {
      kind: options.kind ?? SpanKind.INTERNAL,
      attributes: { ...inheritedAttributes(parent), ...attributes },
      ...(options.links?.length ? { links: options.links } : {}),
    },
    parent,
  )
}

/** Marca el span como fallido sin cortar el flujo — para errores que alguien maneja (un
 *  `onError`), que igual tienen que verse en la traza. */
export function markError(span: Span, err: unknown): void {
  const error = err instanceof Error ? err : new Error(String(err))
  span.recordException(error)
  span.setStatus({ code: SpanStatusCode.ERROR, message: error.message })
}

/** Un método async de `This` — lo único que `@traced` y `@tagged` saben decorar. */
type AsyncMethod<This, Args extends unknown[], R> = (this: This, ...args: Args) => Promise<R>

type MethodDecorator<This, Args extends unknown[], R> = (
  target: This,
  key: string | symbol,
  descriptor: TypedPropertyDescriptor<AsyncMethod<This, Args, R>>,
) => void

/**
 * Lo que un método aporta a la traza, declarado al lado del método en vez de mezclado en su
 * cuerpo. Cada callback corre con `this` = la instancia y los mismos argumentos que el método.
 */
export interface TagOptions<This, Args extends unknown[], R> {
  /** Atributos al empezar — los que se conocen por los argumentos. */
  attributes?(this: This, ...args: Args): Attributes
  /** Qué dejar del resultado: atributos, span events, un log. Si el método tira no corre: el
   *  error ya lo registra `@traced`. */
  onResult?(this: This, span: Span, result: R, ...args: Args): void
}

export interface TraceOptions<This, Args extends unknown[], R> extends TagOptions<This, Args, R> {
  /** Nombre del span. Por defecto `<Clase>.<método>`. */
  name?: string | ((this: This, ...args: Args) => string)
  /** Atributos que heredan este span y TODO span y log creado adentro (ver
   *  `withInheritedAttributes`). */
  inherit?(this: This, ...args: Args): Attributes
  kind?: SpanKind
  /** Instrumentation scope propio, para instrumentar desde otro paquete (un provider). */
  scope?: string
  /** Spans de otras trazas que causaron este (ver `captureSpanLink`). */
  links?(this: This, ...args: Args): SpanLink[] | undefined
}

/** Errores ya logueados por un `@traced` de más adentro: un error sube por varios métodos
 *  trazados (paso → pipeline → evento) y se loguea una sola vez, en el más profundo. */
const loggedErrors = new WeakSet<object>()

/** Si la instancia tiene un campo `log` (un `Logger`), el error que se escapa del método queda
 *  logueado — dentro del span, así que correlacionado con él. */
function logEscapedError(instance: unknown, spanName: string, err: unknown): void {
  const log = (instance as { log?: Logger } | undefined)?.log
  if (typeof log?.error !== 'function') return
  if (typeof err === 'object' && err !== null) {
    if (loggedErrors.has(err)) return
    loggedErrors.add(err)
  }
  const message = err instanceof Error ? err.message : String(err)
  log.error(`${spanName} falló: ${message}`, {
    'exception.type': err instanceof Error ? err.name : typeof err,
  })
}

/**
 * `@traced(opciones)`: el método corre dentro de su propio span (hijo del activo), con los
 * atributos heredados. Si tira, el span queda en ERROR y el error se re-lanza tal cual — y si la
 * instancia tiene un campo `log`, además se loguea (una sola vez aunque suba por varios).
 */
export function traced<This, Args extends unknown[], R>(
  options: TraceOptions<This, Args, R> = {},
): MethodDecorator<This, Args, R> {
  return (target, key, descriptor) => {
    const method = descriptor.value as AsyncMethod<This, Args, R>
    const className = (target as { constructor: { name: string } }).constructor.name
    descriptor.value = function (this: This, ...args: Args): Promise<R> {
      const name =
        typeof options.name === 'function'
          ? options.name.apply(this, args)
          : (options.name ?? `${className}.${String(key)}`)
      const run = () =>
        withSpan(
          name,
          options.attributes?.apply(this, args) ?? {},
          async (span) => {
            let result: R
            try {
              result = await method.apply(this, args)
            } catch (err) {
              logEscapedError(this, name, err)
              throw err
            }
            options.onResult?.call(this, span, result, ...args)
            return result
          },
          {
            kind: options.kind,
            scope: options.scope,
            links: options.links?.apply(this, args) ?? [],
          },
        )
      const inherit = options.inherit?.apply(this, args)
      return inherit ? withInheritedAttributes(inherit, run) : run()
    }
  }
}

/**
 * `@tagged(opciones)`: el método no abre un span propio — le suma atributos y eventos al span
 * activo (el de quien lo llamó). Para lo que es parte de otro paso, no un paso en sí. Sin span
 * activo, no hace nada.
 */
export function tagged<This, Args extends unknown[], R>(
  options: TagOptions<This, Args, R>,
): MethodDecorator<This, Args, R> {
  return (_target, _key, descriptor) => {
    const method = descriptor.value as AsyncMethod<This, Args, R>
    descriptor.value = async function (this: This, ...args: Args): Promise<R> {
      const span = trace.getActiveSpan()
      if (span && options.attributes) span.setAttributes(options.attributes.apply(this, args))
      const result = await method.apply(this, args)
      if (span) options.onResult?.call(this, span, result, ...args)
      return result
    }
  }
}

/**
 * `@taggedSync(opciones)`: como `@tagged`, para un método SINCRÓNICO — uno que tiene que decidir
 * sin ceder el turno (una decisión que otro despacho no puede ver a medias). `onResult` corre
 * antes de devolver.
 */
export function taggedSync<This, Args extends unknown[], R>(
  options: TagOptions<This, Args, R>,
): (
  target: This,
  key: string | symbol,
  descriptor: TypedPropertyDescriptor<(this: This, ...args: Args) => R>,
) => void {
  return (_target, _key, descriptor) => {
    const method = descriptor.value as (this: This, ...args: Args) => R
    descriptor.value = function (this: This, ...args: Args): R {
      const span = trace.getActiveSpan()
      if (span && options.attributes) span.setAttributes(options.attributes.apply(this, args))
      const result = method.apply(this, args)
      if (span) options.onResult?.call(this, span, result, ...args)
      return result
    }
  }
}

// El resto del código (este paquete y los que instrumentan con él) no importa
// `@opentelemetry/api`: los tipos que necesita para declarar una traza salen de acá.
export type { Attributes, Context, Span }
export { SpanKind }
