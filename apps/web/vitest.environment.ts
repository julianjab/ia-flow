import { type Environment, builtinEnvironments } from 'vitest/environments'

/**
 * Entorno de tests: happy-dom, más el arreglo de `localStorage` bajo Node ≥ 22.
 *
 * Node declara `localStorage` y `sessionStorage` como globals propios desde que
 * existe Web Storage experimental — valen `undefined` salvo que el proceso
 * arranque con `--localstorage-file`. Vitest puebla el global con el window de
 * happy-dom salteando toda key que YA exista ahí (`getWindowKeys`: `if (k in
 * global) return KEYS.includes(k)`, y ninguna de las dos está en esa lista), así
 * que la implementación de happy-dom nunca llega y `localStorage.clear()` rompe
 * con "Cannot read properties of undefined".
 *
 * Las borramos del global ANTES de que happy-dom lo pueble — es lo único que hay
 * que hacer: sin la key de Node tapándolas, vitest copia las de happy-dom como
 * cualquier otra parte del DOM. Se restauran en el teardown para no dejar el
 * proceso alterado. Donde el runtime no las declara (Bun, Node < 22) esto es un
 * no-op y el entorno se comporta exactamente como `happy-dom`.
 */
const WEB_STORAGE_KEYS = ['localStorage', 'sessionStorage'] as const

const happyDom = builtinEnvironments['happy-dom']

const environment: Environment = {
  name: 'happy-dom-webstorage',
  transformMode: 'web',
  async setup(global, options) {
    const shadowed = WEB_STORAGE_KEYS.map(
      (key) => [key, Object.getOwnPropertyDescriptor(global, key)] as const,
    ).filter((entry): entry is [(typeof WEB_STORAGE_KEYS)[number], PropertyDescriptor] =>
      Boolean(entry[1]),
    )

    for (const [key] of shadowed) {
      Reflect.deleteProperty(global, key)
    }

    const { teardown } = await happyDom.setup(global, options)

    return {
      async teardown(globalOnTeardown) {
        await teardown(globalOnTeardown)
        for (const [key, descriptor] of shadowed) {
          Object.defineProperty(globalOnTeardown, key, descriptor)
        }
      },
    }
  },
}

export default environment
