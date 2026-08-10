// Barrel: re-export the split modules so old imports keep working. See
//   - providers/types.ts     — StepInput / StepOutput / StepProvider
//   - providers/registry.ts  — module-level provider registry (legacy shape)
//   - providers/config.ts    — defaults + resolveStepSettings + load/save
// The top-level getDb() side-effect is gone — the DB opens lazily on first
// repo access through composition/container.
export * from './types.js'
export * from './registry.js'
export * from './config.js'
