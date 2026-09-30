/**
 * La entrada del bundle publicado (`ia-flow-runner.js`, `scripts/package-release.ts`): el mismo
 * runner que `main.ts`, empaquetado en un solo archivo sin `node_modules` al lado.
 *
 * Lo que el bundle no trae por sí solo son las actions de `.config/` — `.ts` que el runner importa
 * en runtime (`actions/loader.ts`) y que importan paquetes: `@ia-flow/agent-engine`, `zod`, el
 * contrato `@ia-flow/runner-v2/actions`… Desde el árbol de trabajo los resuelve `node_modules`;
 * desde el bundle, no hay de dónde. Por eso se registran acá como módulos virtuales de Bun, con
 * los MISMOS objetos que usa el runner: una action que hace `instanceof` o valida con un schema de
 * zod habla con la instancia del bundle, no con una copia.
 *
 * Una config que importe un paquete que no está en esta lista falla al arrancar con "Cannot find
 * package": para usarlo, se agrega acá.
 */
import { plugin } from 'bun'
import { VIRTUAL_MODULES } from './bundle/modules.js'

plugin({
  name: 'ia-flow-runner-modules',
  setup(build) {
    for (const [specifier, exports] of Object.entries(VIRTUAL_MODULES)) {
      build.module(specifier, () => ({ exports, loader: 'object' }))
    }
  },
})

// Después de registrar los módulos: `main.ts` arranca al importarse, y lo primero que hace es
// cargar las actions.
await import('./main.js')
