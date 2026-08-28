import { Storage } from 'happy-dom'

// Node ≥22 define `localStorage` y `sessionStorage` como getters propios de
// `globalThis` (experimentales, ligados a `--localstorage-file`). Como la
// propiedad YA existe, la inyección de globals de happy-dom 15 no la
// reemplaza —y en vitest `window` ES `globalThis`, así que tampoco queda una
// copia buena en `window.X` de la que rescatarlos—. Los tests terminan viendo
// el storage de Node: `localStorage` es `undefined` sin el flag (lo que
// revienta con "Cannot read properties of undefined") y `sessionStorage` es
// un objeto real pero ajeno al DOM del test — el segundo es peor porque no
// falla, simplemente escribe en otro lado.
//
// El getter de Node es `configurable: true`, así que lo redefinimos con un
// `Storage` de happy-dom, que es exactamente lo que el entorno habría puesto.
// En un Node sin esos globals —el del CI— la guarda de `instanceof` deja el
// storage que ya inyectó happy-dom intacto.
function installHappyDomStorage(key: 'localStorage' | 'sessionStorage') {
  if (globalThis[key] instanceof Storage) return
  Object.defineProperty(globalThis, key, {
    value: new Storage(),
    configurable: true,
    writable: true,
  })
}

installHappyDomStorage('localStorage')
installHappyDomStorage('sessionStorage')
