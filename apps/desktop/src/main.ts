// El proceso principal de las apps de escritorio.
//
// Un solo archivo para las dos, porque hacen lo mismo con distinto contenido:
// mostrar la web de un proceso en una ventana. El modo llega por `--mode`
// (electron-builder lo fija en el `args` de cada bundle; en dev lo pasa
// install.sh o `bun run start`).
//
//   web      → la SPA, que arranca en el selector de server
//   gateway  → el proceso del gateway + su consola, que es otra pantalla de
//              la misma web (`gateway.html`) apuntada a su URL
//
// **Dos formas de correr, y la diferencia es de dónde sale el contenido:**
//
// | | dev (`app.isPackaged === false`) | empaquetado |
// | --- | --- | --- |
// | SPA | `bun run dev:web` del repo (hot reload) | `Resources/web`, servida por esta app |
// | gateway | `bun run src/index.ts` del repo | `Resources/bin/ia-flow-gateway` (binario `bun build --compile`) |
//
// En dev el punto es el hot reload, así que el repo manda. Empaquetado no hay
// repo: todo lo que la app necesita viaja adentro del bundle. Es lo que hace
// que el `.app` se pueda mover a otra máquina.
//
// Por qué no hay diálogos nativos acá: elegir server y configurar el gateway
// ya son pantallas web que existen y están testeadas. Duplicarlas en Electron
// sería mantener dos veces la misma decisión.

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { createConnection } from 'node:net'
import { extname, join, normalize } from 'node:path'
import { BrowserWindow, app, dialog, shell } from 'electron'

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

type Mode = 'web' | 'gateway'

/** Cómo levantar el proceso del repo. Sólo se usa en dev. */
interface DevProcess {
  command: string[]
  cwd: string
  env: Record<string, string>
}

interface ModeConfig {
  title: string
  /** Puerto FIJO, no uno libre cualquiera: la web guarda la elección de server
   *  en el localStorage del origen, y un puerto que cambia en cada arranque
   *  haría perder esa elección todas las veces. */
  port: number
  /** Ruta que se abre al arrancar. */
  path: string
  /** Nombre (sin extensión) del ícono en `icons/`: cada modo instala su propio
   *  bundle, así que el Dock tiene que poder distinguirlos. */
  icon: string
  dev: DevProcess
  /**
   * Binario en `Resources/bin` que reemplaza a `dev` cuando está empaquetado.
   *
   * `null` = este modo no tiene proceso propio; su contenido es estático y lo
   * sirve esta misma app (es el caso de la SPA, que sólo necesita un origen
   * http desde el cual hablarle por CORS al server que elijas).
   */
  bin: string | null
}

const MODES: Record<Mode, ModeConfig> = {
  web: {
    title: 'IA Flow',
    port: 5273,
    path: '/servers',
    icon: 'AppIcon',
    dev: {
      command: ['bun', 'run', 'dev:web'],
      cwd: REPO_ROOT,
      env: { IA_FLOW_WEB_PORT: '5273' },
    },
    bin: null,
  },
  gateway: {
    title: 'IA Flow Gateway',
    port: 3002,
    // La ventana no carga una página del gateway: su consola es apps/web
    // (`gateway.html`) y la sirve ESTA app. El gateway es una API y nada más.
    path: '/gateway.html',
    icon: 'GatewayIcon',
    dev: {
      command: ['bun', 'run', 'src/index.ts'],
      cwd: join(REPO_ROOT, 'apps', 'ai-provider-gateway'),
      env: { PORT: '3002' },
    },
    // Deliberadamente NO se empaqueta: el artefacto que se publica es la app
    // de visualización (modo web). Levantar un gateway es una decisión de
    // infraestructura —qué credenciales, contra qué server— y para eso está su
    // imagen de contenedor (containers/gateway/). Esta app se corre del repo.
    bin: null,
  },
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
 * El bearer del gateway. Es lo que evita que la ventana te pida un token que
 * esta app ya conoce: es el mismo proceso que ella levanta. Nunca sale de la
 * máquina — viaja al preload por argv y termina en el localStorage de esa
 * ventana, y al proceso hijo por env.
 *
 * Se busca en el env del proceso, y después en un archivo. En dev ese archivo
 * es el `.env` del gateway en el repo; empaquetado no hay repo, así que es
 * `~/.config/ia-flow/gateway.env` — el mismo config dir donde el gateway ya
 * guarda su estado y sus logs, y no un lugar nuevo que aprender.
 */
function gatewayToken(): string | null {
  const fromEnv = process.env.API_AI_PROVIDER_TOKEN?.trim()
  if (fromEnv) return fromEnv

  const file = PACKAGED
    ? join(configDir(), 'gateway.env')
    : join(REPO_ROOT, 'apps', 'ai-provider-gateway', '.env')
  try {
    const env = readFileSync(file, 'utf8')
    for (const line of env.split('\n')) {
      const [key, ...rest] = line.trim().split('=')
      if (key === 'API_AI_PROVIDER_TOKEN') return rest.join('=').replace(/^["']|["']$/g, '') || null
    }
  } catch {
    // Sin token el gateway arranca igual y la pantalla lo pide.
  }
  return null
}

/** El config dir de ia-flow, con la misma regla que usa el resto del repo. */
function configDir(): string {
  return process.env.IA_FLOW_CONFIG_DIR ?? join(process.env.HOME ?? '', '.config', 'ia-flow')
}

function parseMode(): Mode {
  const flag = process.argv.find((a) => a.startsWith('--mode='))?.split('=')[1]
  return flag === 'gateway' ? 'gateway' : 'web'
}

const mode = parseMode()
const config = MODES[mode]

// En dev los bundles ejecutan el binario pelado de Electron, así que sin esto
// el menú y el Dock dirían "Electron". Empaquetado el nombre ya viene del
// Info.plist, pero setearlo igual no molesta y mantiene una sola ruta.
app.setName(config.title)
app.whenReady().then(() => {
  app.dock?.setIcon(iconPath())
})

/** El PNG de 1024 que la app se pone en el Dock en runtime. */
function iconPath(): string {
  const dir = PACKAGED ? join(RESOURCES, 'icons') : join(app.getAppPath(), 'icons')
  return join(dir, `${config.icon}.png`)
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
function startChild(): ChildProcess | null {
  const binName = PACKAGED ? config.bin : null
  const [cmd, ...args] = binName ? [join(RESOURCES, 'bin', binName)] : config.dev.command
  if (!cmd) return null

  if (binName && !existsSync(cmd)) {
    dialog.showErrorBox(
      config.title,
      `Falta ${binName} adentro de la app.\n\n` +
        'El bundle se armó sin su binario — rearmalo con `bun run dist`.',
    )
    app.quit()
    return null
  }

  const proc = spawn(cmd, args, {
    cwd: PACKAGED ? configDir() : config.dev.cwd,
    env: {
      ...process.env,
      ...config.dev.env,
      PATH: [
        join(process.env.HOME ?? '', '.bun', 'bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
        process.env.PATH ?? '',
      ].join(':'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  // Los logs van a la consola de Electron: quien depure abre la app desde una
  // terminal y los ve, sin que la app cargue una vista de logs que nadie mira.
  // Abierta desde el Finder ese stdout se pierde, así que el proceso que
  // quiere ser depurable escribe SU propio archivo — el gateway lo hace en
  // ~/.config/ia-flow/logs/gateway.log (apps/ai-provider-gateway/src/logger.ts).
  proc.stdout?.on('data', (d) => process.stdout.write(`[${mode}] ${d}`))
  proc.stderr?.on('data', (d) => process.stderr.write(`[${mode}] ${d}`))
  return proc
}

function createWindow(url: string): BrowserWindow {
  const token = mode === 'gateway' ? gatewayToken() : null
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: config.title,
    backgroundColor: '#0f1113',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: join(app.getAppPath(), 'dist', 'preload.cjs'),
      additionalArguments: token ? [`--gateway-token=${token}`] : [],
    },
  })
  // Los links externos (un repo de GitHub, el PR de un run) van al navegador:
  // dejarlos navegar acá adentro convertiría la app en un browser sin barra
  // de direcciones, sin forma de volver.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target)
    return { action: 'deny' }
  })
  win.loadURL(url)
  return win
}

/**
 * ¿Esta app sirve el contenido, o lo sirve el proceso que levanta?
 *
 * La consola del gateway SIEMPRE la sirve esta app (el gateway es una API sin
 * pantalla). La SPA sólo cuando está empaquetada: en dev la sirve su dev
 * server, que es de donde sale el hot reload.
 */
function servesWebItself(): boolean {
  return mode === 'gateway' || PACKAGED
}

function missingBundle(): boolean {
  const entry = mode === 'gateway' ? 'gateway.html' : 'index.html'
  return !existsSync(join(WEB_ROOT, entry))
}

async function boot(): Promise<void> {
  // El modo web empaquetado no tiene proceso hijo: su contenido es estático.
  const needsChild = !(mode === 'web' && PACKAGED)

  if (needsChild) {
    // Si ya está corriendo (lo levantaste vos, u otra ventana), no se levanta
    // un segundo: se muestra el que hay. El puerto es de a uno.
    if (!(await isPortTaken(config.port))) {
      child = startChild()
      if (!child) return
    }
    if (!(await waitForPort(config.port))) {
      dialog.showErrorBox(
        config.title,
        `No arrancó en :${config.port}.\n\n` +
          'Abrí la app desde una terminal para ver el log del proceso.',
      )
      app.quit()
      return
    }
  }

  // Sin bundle propio: la SPA la sirve su dev server (modo web en dev).
  if (!servesWebItself()) {
    createWindow(`http://localhost:${config.port}${config.path}`)
    return
  }

  if (missingBundle()) {
    dialog.showErrorBox(
      config.title,
      PACKAGED
        ? 'Falta el bundle de la web adentro de la app.\n\nRearmala con `bun run dist`.'
        : 'Falta el bundle de la web.\n\nCorré: bun run --cwd apps/web build',
    )
    app.quit()
    return
  }

  try {
    // El modo web sirve en su puerto FIJO (la elección de server vive en el
    // localStorage de ese origen). El gateway sirve en uno efímero: su origen
    // no guarda nada que dependa del puerto, y así no choca con nada.
    // Si el puerto fijo está tomado, ya hay una ventana sirviendo lo mismo —
    // nos colgamos de ella en vez de fallar.
    const servePort = mode === 'web' ? config.port : 0
    // `localhost` y NO `127.0.0.1` en la rama de reuso: `isPortTaken` prueba
    // los DOS stacks, así que da true también para un server que escucha sólo
    // en `[::1]` — que es exactamente el caso de Vite. Con la IPv4 hardcodeada
    // la ventana apuntaba a una dirección donde nadie contesta y abría con
    // ERR_CONNECTION_REFUSED. `localhost` resuelve a los dos.
    const base =
      mode === 'web' && (await isPortTaken(config.port))
        ? `http://localhost:${config.port}`
        : await serveWeb(servePort, mode === 'web')

    // El gateway al que apunta la consola viaja en la query — así la misma
    // pantalla sirve para el proceso local y para cualquier otro que el
    // operador tipee.
    const query = mode === 'gateway' ? `?url=http://localhost:${config.port}` : ''
    createWindow(`${base}${config.path}${query}`)
  } catch (err) {
    dialog.showErrorBox(config.title, `No pude servir la web: ${String(err)}`)
    app.quit()
  }
}

app.whenReady().then(boot)

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
