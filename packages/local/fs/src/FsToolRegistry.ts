import { type ToolConstructor, ToolRegistry } from '@ia-flow/agent-engine'
import { FsEditTool, FsGrepTool, FsListTool, FsReadTool, FsWriteTool } from './tools/index.js'

/**
 * Acceso por nombre a las 5 fs_* tools, todas contenidas al mismo `baseDir`. Mismo diseño que
 * `GithubToolRegistry` (`@ia-flow/github-tools`): extiende `ToolRegistry` de agent-engine,
 * registro centralizado acá (no en cada archivo de tool) para evitar el ciclo ESM/TDZ — ver la
 * nota en `GithubToolRegistry.ts` para el porqué completo.
 */
export class FsToolRegistry extends ToolRegistry<[string]> {
  protected static registeredTools: ToolConstructor<[string]>[] = []
}

FsToolRegistry.register(FsReadTool)
FsToolRegistry.register(FsListTool)
FsToolRegistry.register(FsGrepTool)
FsToolRegistry.register(FsWriteTool)
FsToolRegistry.register(FsEditTool)
