// Corre antes que los scripts de la página, en el mundo aislado, pero contra
// el MISMO origen — así que el localStorage que escribe acá es el que lee la
// página después.
//
// Sirve para una sola cosa: que la ventana del gateway no te pida un token que
// esta app ya conoce (lo lee del .env del gateway, que es el mismo proceso que
// levanta). En el navegador la pantalla sigue pidiéndolo, porque ahí nadie
// puede saberlo por vos.

const TOKEN_KEY = 'ia-flow:gateway:token'

const token = process.argv
  .find((a) => a.startsWith('--gateway-token='))
  ?.slice('--gateway-token='.length)

if (token) {
  try {
    window.localStorage.setItem(TOKEN_KEY, token)
  } catch {
    // Storage bloqueado: la pantalla cae al formulario de siempre.
  }
}
