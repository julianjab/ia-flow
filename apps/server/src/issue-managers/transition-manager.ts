// Re-exports the canonical port from the domain layer. Historically the
// interface was declared here too and drifted — keep a single definition.
export type { ITransitionManager as TransitionManager } from '../domain/ports/ITransitionManager.js'
