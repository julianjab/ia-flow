import { SchemaTool, type ToolInputSchema } from '@ia-flow/agent-engine'
import { resolveSafePath } from './shared.js'

/** Base de las 5 fs_* tools — comparte `this.baseDir` y `this.resolveSafePath(...)` (delegado a
 *  la función pura en `shared.ts`, testeada aparte en `shared.test.ts`). Async porque valida
 *  symlinks contra disco (`realpath`) — ver `shared.ts`. El input lo valida `SchemaTool` contra
 *  el `input` (zod) de cada tool antes de llegar a `execute`. */
export abstract class FsTool<S extends ToolInputSchema> extends SchemaTool<S> {
  constructor(protected readonly baseDir: string) {
    super()
  }

  protected resolveSafePath(relativePath: string): Promise<string> {
    return resolveSafePath(this.baseDir, relativePath)
  }
}
