// El proceso principal de IA Flow.app — la app de visualización.
//
// Una sola app y un solo modo. Antes eran dos (`IA Flow` y `IA Flow Gateway`),
// porque la consola del gateway era un bundle aparte de la web. Ya no lo es:
// es la ruta `/gateway` de la misma SPA, así que dos ventanas, dos .app y dos
// íconos eran dos veces la misma cosa.
//
// Lo que la app hace es corto: sirve la SPA y la muestra. **No levanta ningún
// proceso** — ni server ni gateway. Esos se levantan con su bundle publicado
// (ver containers/README.md) y la app se conecta al que elijas en su pantalla
// de servers, con el token que le configures ahí.
//
// | | dev (`app.isPackaged === false`) | empaquetado |
// | --- | --- | --- |
// | la SPA | `bun run dev:web` del repo (hot reload) | `Resources/web`, servida por esta app |
//
// La lista de servers y sus tokens los persiste el main process en
// `<configDir>/desktop-servers.json`, expuesto al renderer por IPC — ver
// `registerServersIpc` más abajo.

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  chmodSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { createConnection } from 'node:net'
import { extname, join, normalize } from 'node:path'
import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron'

/**
 * Empaquetado o corriendo del repo. Es la única bifurcación de este archivo:
 * todo lo demás deriva de acá.
 */
const PACKAGED = app.isPackaged

/**
 * `Contents/Resources` del bundle — donde electron-builder deja `web/` y
 * `bin/` (ver `extraResources` en electron-builder.yml).
 */
const RESOURCES = process.resourcesPath

// `app.getAppPath()` (= apps/desktop) y no `import.meta.url`: el main de
// Electron se carga como CommonJS, donde `import.meta` no existe. Empaquetado
// esto apunta adentro del asar y no significa nada — por eso sólo se usa en
// las ramas de dev.
const REPO_ROOT = join(app.getAppPath(), '..', '..')

/**
 * Puerto FIJO, no uno libre cualquiera: la elección de server vive en el
 * localStorage del origen, y un puerto que cambia en cada arranque haría
 * perder esa elección todas las veces.
 */
const PORT = 5273

/** Ruta que se abre al arrancar: elegir server es el primer paso. */
const START_PATH = '/servers'

const TITLE = 'IA Flow'

// ANTES que cualquier `app.getPath('userData')`: ese path se deriva del nombre
// de la app, así que leerlo antes de este `setName` devolvía el directorio de
// `Electron` en vez del nuestro — y ahí iban a parar el marcador y la lista de
// servers. Sin esto, el nombre correcto llegaba recién después de que ya
// hubiéramos resuelto los dos.
app.setName(TITLE)

/** Cómo levantar la web del repo en dev. Empaquetado no se usa. */
const DEV_WEB = {
  command: ['bun', 'run', 'dev:web'],
  cwd: REPO_ROOT,
  env: { IA_FLOW_WEB_PORT: String(PORT) },
}

/**
 * Raíz de los archivos estáticos de la web.
 *
 * Empaquetado sale del bundle; en dev, del `dist` del repo — que es lo que ya
 * pedía la consola del gateway, y ahora también la SPA cuando se la sirve
 * desde acá.
 */
const WEB_ROOT = PACKAGED ? join(RESOURCES, 'web') : join(REPO_ROOT, 'apps', 'web', 'dist')

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json; charset=utf-8',
}

/**
 * Cómo reconocemos a nuestro propio server estático.
 *
 * Existe por un agujero concreto del reuso de puerto: la ventana carga la URL
 * CON el preload, y ese preload expone `iaFlowDesktop.loadServers()`, que
 * devuelve la lista de servers **con sus tokens en claro** (y `saveServers`
 * para pisarlos). Si cualquier proceso local ocupa el 5273 antes que nosotros,
 * cargarlo a ciegas le entrega esas credenciales a una página ajena.
 *
 * El valor es por-arranque y no una constante: una página que quiera hacerse
 * pasar por nuestro server tendría que adivinarlo, no leerlo del código.
 */
const MARKER_PATH = '/__ia-flow-desktop'

/**
 * Un secreto COMPARTIDO entre instancias, persistido en el config dir.
 *
 * Aleatorio por-arranque no servía: una segunda ventana generaba un valor
 * distinto del que sirve la primera, así que `isOurs` daba false SIEMPRE y el
 * camino empaquetado terminaba siempre en el diálogo de error. O sea que el
 * reuso —el motivo por el que el puerto es fijo— quedaba muerto.
 *
 * Que viva en el config dir no lo debilita: quien pueda leer ese archivo ya
 * puede leer `desktop-servers.json`, que tiene los tokens en claro. Lo que este
 * secreto evita es que un proceso CUALQUIERA se haga pasar por nuestro server.
 */
function readOrCreateMarker(): string {
  const file = join(appConfigDir(), 'marker')
  try {
    const existing = readFileSync(file, 'utf8').trim()
    if (existing) return existing
  } catch {
    /* primer arranque */
  }
  // `randomBytes` y no `Math.random()`: es lo ÚNICO que decide si nos colgamos
  // de un puerto ajeno entregándole el bridge de tokens. `Math.random` no es
  // un CSPRNG y `Date.now()` es adivinable — para un secreto cuyo propósito
  // explícito es que otro proceso no pueda hacerse pasar por nuestro server,
  // eso no alcanza.
  const fresh = `ia-flow-desktop:${randomBytes(32).toString('hex')}`
  try {
    mkdirSync(appConfigDir(), { recursive: true })
    writeFileSync(file, `${fresh}\n`, { mode: 0o600 })
  } catch {
    // No se pudo persistir: el marcador vale para esta instancia y el reuso
    // no va a funcionar, pero es el lado seguro del error.
  }
  return fresh
}

/**
 * Perezoso y cacheado, no una const de módulo.
 *
 * `readOrCreateMarker()` toca `app.getPath('userData')`, y en tiempo de import
 * ese path todavía puede no ser el definitivo. Resolverlo en el primer uso —ya
 * con la app configurada— es lo que garantiza que el archivo caiga donde
 * corresponde.
 */
let markerCache: string | null = null
function marker(): string {
  if (markerCache === null) markerCache = readOrCreateMarker()
  return markerCache
}

/**
 * ¿Lo que está escuchando en ese puerto es nuestro?
 *
 * En dev un `false` es normal y esperable: ahí el ocupante es el dev server de
 * Vite, que obviamente no conoce la marca. Por eso esto sólo decide en el
 * camino empaquetado.
 */
async function isOurs(port: number): Promise<boolean> {
  const nonce = randomBytes(16).toString('hex')
  const expected = createHmac('sha256', marker()).update(nonce).digest('hex')
  try {
    const res = await fetch(`http://localhost:${port}${MARKER_PATH}?n=${nonce}`, {
      signal: AbortSignal.timeout(1_000),
    })
    if (!res.ok) return false
    const got = (await res.text()).trim()
    // Comparación en tiempo constante, por lo mismo que el guard del gateway.
    const a = Buffer.from(got)
    const b = Buffer.from(expected)
    return a.length === b.length && timingSafeEqual(a, b)
  } catch {
    return false
  }
}

/**
 * Sirve el bundle de la web desde esta app, en loopback.
 *
 * Por qué un server y no un `file://`: la web le habla al server (o al
 * gateway) por fetch cross-origin, y un origen `file://` (o `null`) no es
 * reflejable por CORS. Además el preload escribe el token en el localStorage
 * del origen, y `file://` no tiene uno estable.
 *
 * `spaFallback` es lo que hace servible a la SPA y no sólo a la consola: el
 * router usa `createWebHistory`, así que `/servers` o `/dashboard` son rutas
 * del cliente y no archivos — sin el fallback devolverían 404 y la ventana
 * abriría en blanco.
 */
function serveWeb(port: number, spaFallback: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const requested = new URL(req.url ?? '/', 'http://localhost').pathname

      // El desafío que identifica a ESTE server como nuestro. Se responde un
      // HMAC del nonce que manda el cliente, NO el secreto.
      //
      // Servir el secreto entero anulaba su propósito: un proceso local lo
      // leía mientras la app corría, esperaba a que cerrara, se quedaba con el
      // puerto y respondía el mismo valor — `isOurs` daba true y la ventana
      // siguiente cargaba esa página CON `--ia-flow-trusted`, o sea con los
      // tokens. Con un nonce fresco por chequeo, haber visto respuestas
      // anteriores no sirve de nada.
      if (requested === MARKER_PATH) {
        const nonce = new URL(req.url ?? '/', 'http://localhost').searchParams.get('n') ?? ''
        if (!nonce) {
          res.writeHead(400).end('missing nonce')
          return
        }
        res
          .writeHead(200, { 'content-type': 'text/plain' })
          .end(createHmac('sha256', marker()).update(nonce).digest('hex'))
        return
      }

      // `/api` y `/ws` NUNCA caen en el fallback de la SPA. Este server no
      // proxea nada: devolver index.html con 200 haría que axios parsee HTML
      // como JSON y la app se rompa sin un solo error legible. Un 404 dice la
      // verdad — acá no hay API.
      if (requested === '/api' || requested.startsWith('/api/') || requested.startsWith('/ws')) {
        res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"no api here"}')
        return
      }

      const rel = requested === '/' ? '/index.html' : requested
      // Ancla el path dentro del root: sin esto, un `..` en la URL leería
      // cualquier archivo de la máquina.
      const file = join(WEB_ROOT, normalize(rel).replace(/^(\.\.[/\\])+/, ''))
      const hit = file.startsWith(WEB_ROOT) && existsSync(file) && statSync(file).isFile()

      // Una ruta del router (sin extensión) cae al index; un asset que falta
      // sigue siendo 404, para que un bundle incompleto se vea como lo que es
      // y no como una página que carga a medias.
      const target = hit ? file : spaFallback && !extname(rel) ? join(WEB_ROOT, 'index.html') : null
      if (!target || !existsSync(target)) {
        res.writeHead(404).end('not found')
        return
      }
      res.writeHead(200, {
        'content-type': CONTENT_TYPES[extname(target)] ?? 'application/octet-stream',
      })
      createReadStream(target).pipe(res)
    })
    server.on('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      if (address && typeof address === 'object') resolve(`http://127.0.0.1:${address.port}`)
      else reject(new Error('el server de la web no devolvió un puerto'))
    })
  })
}

/**
 * Dónde guarda SUS cosas esta app.
 *
 * `app.getPath('userData')` —en macOS `~/Library/Application Support/IA Flow`—
 * y NO el config dir del server (`~/.config/ia-flow`), que es donde estaba
 * antes. Dos motivos:
 *
 *  - Son cosas distintas. Ahí viven el `ia-flow.sqlite`, el `gateway.json` y
 *    los `repos/` del SERVER. La lista de servers es estado del cliente: a qué
 *    máquinas mira ESTA instalación. Mezclarlas hacía que borrar la config del
 *    server se llevara puesta la de la app, y al revés.
 *  - `IA_FLOW_CONFIG_DIR` es del server. Apuntarlo al volumen de un contenedor
 *    —que es exactamente para lo que existe— movía también la lista de la app,
 *    que no tiene nada que ver con ese deploy.
 */
function appConfigDir(): string {
  return app.getPath('userData')
}

/**
 * El config dir del SERVER (`~/.config/ia-flow`). Sólo se mira para migrar lo
 * que una versión anterior de esta app dejó ahí — ver `migrateLegacyServers`.
 */
function legacyConfigDir(): string {
  return process.env.IA_FLOW_CONFIG_DIR ?? join(process.env.HOME ?? '', '.config', 'ia-flow')
}

/**
 * Los servers que el usuario declaró, en el config dir de ia-flow.
 *
 * Es un archivo y no el localStorage de la ventana porque es CONFIG: sobrevive
 * a limpiar datos del sitio, se puede editar a mano, y queda junto al resto de
 * la config en vez de adentro del perfil de Chromium.
 *
 * Al lado del `gateway.json` del gateway y del `ia-flow.sqlite` del server, con
 * la misma regla de `IA_FLOW_CONFIG_DIR`.
 */
function serversFile(): string {
  return join(appConfigDir(), 'servers.json')
}

/**
 * Trae la lista que una versión anterior dejó en el config dir del server.
 *
 * Una sola vez y sin pisar: si ya hay una lista en el lugar nuevo, la vieja se
 * ignora. No se borra el original — que un cambio de ubicación destruya el
 * único archivo con los tokens sería el peor momento para equivocarse.
 */
function migrateLegacyServers(): void {
  const legacy = join(legacyConfigDir(), 'desktop-servers.json')
  if (existsSync(serversFile()) || !existsSync(legacy)) return
  try {
    mkdirSync(appConfigDir(), { recursive: true })
    writeFileSync(serversFile(), readFileSync(legacy, 'utf8'), { mode: 0o600 })
    chmodSync(serversFile(), 0o600)
    process.stdout.write(`[desktop] servers migrados de ${legacy} a ${serversFile()}\n`)
  } catch (err) {
    process.stderr.write(`[desktop] no pude migrar los servers: ${String(err)}\n`)
  }
}

/**
 * Se registran antes de crear la ventana: el renderer puede pedir la lista en
 * su primer tick, y un `invoke` sin handler rechaza en vez de esperar.
 */
function registerServersIpc(): void {
  migrateLegacyServers()

  /**
   * Sólo contesta a una página del origen que servimos nosotros.
   *
   * Cinturón sobre el `will-navigate` de createWindow: si alguna vez se abre un
   * camino de navegación que ese guard no cubra, los tokens no se entregan
   * igual. Dos chequeos independientes para el mismo secreto es barato.
   */
  const fromOurPage = (e: { senderFrame: { url: string } | null }): boolean => {
    const url = e.senderFrame?.url
    if (!url) return false
    try {
      const parsed = new URL(url)
      // Los TRES nombres del loopback, y no sólo `localhost`: el arranque
      // empaquetado normal carga la ventana con lo que devuelve `serveWeb()`,
      // que es `http://127.0.0.1:<port>`, mientras que la rama de reuso usa
      // `localhost`. Exigiendo sólo uno, el camino principal quedaba sin
      // bridge: `servers:load` devolvía [] y `servers:save` era un no-op
      // SILENCIOSO — agregabas un server con su token, parecía guardarse, y al
      // reabrir la lista estaba vacía.
      const loopback = ['localhost', '127.0.0.1', '[::1]', '::1']
      return parsed.port === String(PORT) && loopback.includes(parsed.hostname)
    } catch {
      return false
    }
  }

  ipcMain.handle('servers:load', (e) => {
    if (!fromOurPage(e as never)) return []
    try {
      return JSON.parse(readFileSync(serversFile(), 'utf8'))
    } catch {
      // No existe (primer arranque) o está corrupto. Una lista vacía es
      // recuperable tipeando; tirar acá dejaría la pantalla sin servers y sin
      // forma de agregarlos.
      return []
    }
  })

  ipcMain.handle('servers:save', (e, servers: unknown) => {
    if (!fromOurPage(e as never)) return
    // Se valida la FORMA, no el contenido: esto viene del renderer, que es
    // nuestro, pero escribir cualquier cosa que llegue haría del archivo un
    // vertedero. Lo que no matchea se descarta.
    const list = Array.isArray(servers)
      ? servers.filter(
          (s): s is Record<string, unknown> =>
            !!s &&
            typeof s === 'object' &&
            typeof (s as { baseUrl?: unknown }).baseUrl === 'string',
        )
      : []
    try {
      mkdirSync(appConfigDir(), { recursive: true })
      // 0600: este archivo tiene los tokens EN CLARO. Con el umask por
      // default quedaba 0644, o sea legible por cualquier usuario o proceso de
      // la máquina — lo que volvía decorativo todo el cuidado del bridge.
      writeFileSync(serversFile(), `${JSON.stringify(list, null, 2)}\n`, { mode: 0o600 })
      // `mode` de writeFileSync sólo aplica cuando CREA el archivo. Un
      // desktop-servers.json escrito por una versión anterior (umask → 0644)
      // seguiría siendo legible por cualquier usuario después del "arreglo".
      chmodSync(serversFile(), 0o600)
    } catch (err) {
      // Disco lleno, permisos: la lista sigue viva en la ventana hasta que se
      // cierre. Avisar es mejor que fallar en silencio.
      process.stderr.write(`[desktop] no pude guardar los servers: ${String(err)}\n`)
    }
  })
}

app.whenReady().then(() => {
  app.dock?.setIcon(iconPath())
})

/** El PNG de 1024 que la app se pone en el Dock en runtime. */
function iconPath(): string {
  const dir = PACKAGED ? join(RESOURCES, 'icons') : join(app.getAppPath(), 'icons')
  return join(dir, 'AppIcon.png')
}

let child: ChildProcess | null = null

function connects(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port })
    const done = (ok: boolean) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/**
 * ¿Hay algo escuchando ahí?
 *
 * Un TCP connect, no un bind de prueba: bindear puede tener éxito aunque otro
 * proceso esté sirviendo el mismo puerto (reuse de socket). Y se prueban los
 * DOS stacks: Vite escucha en `[::1]`, así que mirar sólo `127.0.0.1` daba
 * "libre" con un dev server ya corriendo — levantábamos un segundo que moría
 * con EADDRINUSE y después esperábamos 60s a un puerto que nunca íbamos a ver.
 */
async function isPortTaken(port: number, timeoutMs = 600): Promise<boolean> {
  for (const host of ['127.0.0.1', '::1']) {
    if (await connects(host, port, timeoutMs)) return true
  }
  return false
}

async function waitForPort(port: number, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isPortTaken(port)) return true
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

/**
 * Levanta el proceso del modo: el binario del bundle si está empaquetado, el
 * comando del repo si no.
 *
 * El PATH se completa a mano porque una app abierta desde el Finder arranca
 * con el del sistema — sin `bun`, sin nada de Homebrew. Empaquetado el binario
 * es autocontenido y no lo necesita, pero completarlo igual cuesta nada y
 * cubre a un hijo que sí llame a `git`.
 */
/**
 * Levanta el dev server de la web. SÓLO en dev — empaquetado, la SPA la sirve
 * esta misma app desde su bundle y no hay ningún proceso hijo.
 *
 * El PATH se completa a mano porque una app abierta desde el Finder arranca
 * con el del sistema: sin `bun`, sin nada de Homebrew.
 */
function startChild(): ChildProcess {
  const [cmd, ...args] = DEV_WEB.command
  const proc = spawn(cmd as string, args, {
    cwd: DEV_WEB.cwd,
    env: {
      ...process.env,
      ...DEV_WEB.env,
      PATH: [
        join(process.env.HOME ?? '', '.bun', 'bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
        process.env.PATH ?? '',
      ].join(':'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  proc.stdout?.on('data', (d) => process.stdout.write(`[web] ${d}`))
  proc.stderr?.on('data', (d) => process.stderr.write(`[web] ${d}`))
  return proc
}

/**
 * @param trusted la página que se va a cargar la sirvió esta app, o un puerto
 *   cuyo ocupante verificamos. Decide si el preload expone el puente que da
 *   acceso a los tokens — ver preload.ts.
 */
function createWindow(url: string, trusted: boolean): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: TITLE,
    backgroundColor: '#0f1113',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: join(app.getAppPath(), 'dist', 'preload.cjs'),
      additionalArguments: trusted ? ['--ia-flow-trusted'] : [],
    },
  })
  // Los links externos (un repo de GitHub, el PR de un run) van al navegador:
  // dejarlos navegar acá adentro convertiría la app en un browser sin barra
  // de direcciones, sin forma de volver.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target)
    return { action: 'deny' }
  })

  // Y `will-navigate` para la navegación TOP-LEVEL, que el handler de arriba no
  // cubre: ese sólo ve `window.open` y `target=_blank`.
  //
  // No es un detalle de UX, es lo que sostiene al `--ia-flow-trusted`. Ese flag
  // es del webContents, no de la URL: el preload lo evalúa en CADA página que
  // se cargue en esta ventana. Sin este guard, un link normal —o cualquier
  // `location.assign`, que es justo el patrón que usa `enter()`— llevaría la
  // ventana a otro origen y esa página vería `window.iaFlowDesktop`, o sea
  // `loadServers()` con todos los tokens.
  const allowedOrigin = new URL(url).origin
  win.webContents.on('will-navigate', (event, target) => {
    let origin: string
    try {
      origin = new URL(target).origin
    } catch {
      event.preventDefault()
      return
    }
    if (origin === allowedOrigin) return
    event.preventDefault()
    shell.openExternal(target)
  })
  win.loadURL(url)
  return win
}

async function boot(): Promise<void> {
  // Empaquetado la SPA viaja adentro y la servimos nosotros; en dev la sirve
  // su dev server, que es de donde sale el hot reload.
  if (!PACKAGED) {
    // Si ya hay algo en el puerto (lo levantaste vos, u otra ventana), no se
    // levanta un segundo: el puerto es de a uno.
    // Confiable sólo si el dev server lo levantamos NOSOTROS. Si el puerto ya
    // estaba ocupado no podemos saber por quién —Vite no publica ninguna
    // marca— así que la ventana se carga igual (es la comodidad de dev) pero
    // sin el puente a los tokens.
    let trusted = false
    if (!(await isPortTaken(PORT))) {
      child = startChild()
      trusted = true
    }
    if (!(await waitForPort(PORT))) {
      dialog.showErrorBox(
        TITLE,
        `La web no arrancó en :${PORT}.\n\n` +
          'Abrí la app desde una terminal para ver el log del proceso.',
      )
      app.quit()
      return
    }
    createWindow(`http://localhost:${PORT}${START_PATH}`, trusted)
    return
  }

  if (!existsSync(join(WEB_ROOT, 'index.html'))) {
    dialog.showErrorBox(
      TITLE,
      'Falta el bundle de la web adentro de la app.\n\nRearmala con `bun run dist`.',
    )
    app.quit()
    return
  }

  try {
    // `localhost` y NO `127.0.0.1` en la rama de reuso: `isPortTaken` prueba
    // los dos stacks, así que da true también para un server que escucha sólo
    // en `[::1]` — el caso de Vite. Con la IPv4 hardcodeada la ventana
    // apuntaba a una dirección donde nadie contesta.
    if (await isPortTaken(PORT)) {
      // Ocupado. Sólo se reusa si es OTRA ventana de esta misma app: la ventana
      // se carga con el preload, que expone la lista de servers con sus tokens.
      // Colgarse a ciegas de lo que sea que esté ahí se los entregaría.
      if (!(await isOurs(PORT))) {
        dialog.showErrorBox(
          TITLE,
          `El puerto ${PORT} está ocupado por otro proceso.\n\n` +
            'La app no se cuelga de algo que no reconoce: la ventana tiene acceso ' +
            'a tus tokens.\n\nLiberá el puerto y volvé a abrirla.',
        )
        app.quit()
        return
      }
      // `localhost` y NO `127.0.0.1`: `isPortTaken` prueba los dos stacks, así
      // que un server que escucha sólo en `[::1]` da true igual, y con la IPv4
      // hardcodeada la ventana apuntaría a donde nadie contesta.
      createWindow(`http://localhost:${PORT}${START_PATH}`, true)
      return
    }
    const base = await serveWeb(PORT, true)
    createWindow(`${base}${START_PATH}`, true)
  } catch (err) {
    dialog.showErrorBox(TITLE, `No pude servir la web: ${String(err)}`)
    app.quit()
  }
}

app.whenReady().then(() => {
  registerServersIpc()
  return boot()
})

app.on('window-all-closed', () => app.quit())

// El hijo es nuestro: si se va la app sin matarlo queda un Vite (o un gateway)
// huérfano ocupando el puerto, y el próximo arranque se cuelga de un proceso
// que ya nadie supervisa.
//
// `before-quit` no alcanza: un `kill` al proceso de Electron (o un pkill) no
// dispara ese evento, y ahí es justamente cuando queda el huérfano. Por eso se
// atienden también las señales y el exit del proceso.
function killChild(): void {
  child?.kill()
  child = null
}

app.on('before-quit', killChild)
process.on('exit', killChild)
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(signal, () => {
    killChild()
    app.quit()
  })
}
