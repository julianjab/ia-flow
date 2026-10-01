/**
 * Registra los paquetes de `modules.ts` como módulos virtuales de Bun: un `import` de
 * `@ia-flow/agent-engine` (o `zod`, o el contrato de las actions) desde un `.ts` de CUALQUIER
 * carpeta resuelve a los mismos objetos que usa el runner, sin `node_modules` al lado.
 *
 * Lo llama `main.ts` antes de cargar nada (desde el árbol de trabajo y en el bundle publicado), y
 * los tests (preload de `bunfig.toml`): así una config vive donde sea —la de un deploy, una copia
 * en el tmp de un test— y no dentro de la app.
 */
import { plugin } from 'bun'
import { VIRTUAL_MODULES } from './modules.js'

export function registerVirtualModules(): void {
  plugin({
    name: 'ia-flow-runner-modules',
    setup(build) {
      for (const [specifier, exports] of Object.entries(VIRTUAL_MODULES)) {
        build.module(specifier, () => ({ exports, loader: 'object' }))
      }
    },
  })
}
