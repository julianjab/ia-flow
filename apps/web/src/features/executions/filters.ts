import type { ExecutionLog } from '@ia-flow/shared'

// Client-side filters applied on top of the already-loaded page.
//
// `pending` narrows to rows with `outcome === null` — i.e. in-flight runs
// or orphans that never got a terminal outcome. 'pending' is intentionally
// NOT a value of the shared OutcomeSchema (see packages/shared/src/schemas.ts)
// so it can't be sent to `GET /api/executions`; the summary chip toggles
// this flag and the pipeline below does the narrowing here.
//
// `taskText` MUST be the already-normalized query (trim + lowercase). The
// caller — usually a debounced watcher — holds the raw input separately so
// the text input stays snappy.
export interface ExecutionClientFilters {
  pending?: boolean
  taskText?: string
}

/** Applies the pending + text client-side filters to a loaded page of
 * executions. Filters combine with AND, in the same order the original
 * inline computed used them (pending first, then text), so that swapping
 * the inline pipeline for this helper is a no-op refactor. */
export function filterExecutions(
  executions: readonly ExecutionLog[],
  opts: ExecutionClientFilters = {},
): ExecutionLog[] {
  let result: readonly ExecutionLog[] = executions
  if (opts.pending) {
    result = result.filter((e) => e.outcome === null)
  }
  const q = opts.taskText ?? ''
  if (q) {
    result = result.filter(
      (e) => e.taskTitle.toLowerCase().includes(q) || e.taskId.toLowerCase().includes(q),
    )
  }
  // Materialize so the caller always gets a fresh Array (Vue's computed will
  // hold onto it and mutating a readonly slice would be surprising).
  return result === executions ? [...result] : (result as ExecutionLog[])
}
