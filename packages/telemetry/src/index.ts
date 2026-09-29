export type { ConsoleSinkOptions, Logger, LogLevel, LogRecord, LogSink } from './logging.js'
export { addLogSink, consoleSink, createLogger, otelSink, setLogSinks } from './logging.js'
export type {
  Attributes,
  Context,
  Span,
  SpanLink,
  SpanOptions,
  TagOptions,
  TraceOptions,
} from './tracing.js'
export {
  captureContext,
  captureSpanLink,
  INSTRUMENTATION_SCOPE,
  inFreshContext,
  inheritedAttributes,
  MAX_ATTRIBUTE_LENGTH,
  markError,
  SpanKind,
  scopeAttributes,
  startSpan,
  tagged,
  taggedSync,
  traced,
  truncate,
  withInheritedAttributes,
  withSpan,
} from './tracing.js'
