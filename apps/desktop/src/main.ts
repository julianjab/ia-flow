// El proceso principal de las apps de escritorio.
//
// Un solo archivo para las dos, porque hacen lo mismo con distinto contenido:
// levantar un proceso del repo y mostrar SU web en una ventana. El modo llega
// por `--mode` (lo fija cada bundle en install.sh).
//
//   web      → `bun run dev:web` + la SPA, que arranca en el selector de server
//   gateway  → el proceso del gateway + su consola, que sirve ESTA app desde
//              el bundle de la web (apps/web/dist/gateway.html). El gateway ya
//              no trae pantalla propia: es una API, y su consola es una más
//              de las pantallas de la web, apuntada a su URL.
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

// `app.getAppPath()` (= apps/desktop) y no `import.meta.url`: el main de
// Electron se carga como CommonJS, donde `import.meta` no existe.
const REPO_ROOT = join(app.getAppPath(), '..', '..')

type Mode = 'web' | 'gateway'

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
  command: string[]
  cwd: string
  env: Record<string, string>
}

const MODES: Record<Mode, ModeConfig> = {
  web: {
    title: 'IA Flow',
    port: 5273,
    path: '/servers',
    icon: 'AppIcon',
    command: ['bun', 'run', 'dev:web'],
    cwd: REPO_ROOT,
    env: { IA_FLOW_WEB_PORT: '5273' },
  },
  gateway: {
    title: 'IA Flow Gateway',
    port: 3002,
    // La ventana ya NO carga una página del gateway: su consola es
    // apps/web (`gateway.html`) y la sirve ESTA app (ver serveConsole). El
    // `path` queda sin uso en este modo.
    path: '/',
    icon: 'GatewayIcon',
    command: ['bun', 'run', 'src/entry/server.ts'],
    cwd: join(REPO_ROOT, 'apps', 'ai-provider-gateway'),
    env: {},
  },
}

/** Dist de la web — de ahí sale `gateway.html` y sus assets. */
const WEB_DIST = join(REPO_ROOT, 'apps', 'web', 'dist')

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

/**
 * Sirve la consola del gateway desde el bundle de la web, en un puerto
 * efímero de loopback.
 *
 * Por qué un server y no un `file://`: la consola le habla al gateway por
 * fetch cross-origin, y un origen `file://` (o `null`) no es reflejable por
 * CORS — el gateway sólo refleja orígenes http de loopback (ver cors.ts).
 * Además el preload escribe el token en el localStorage del origen, y
 * `file://` no tiene uno estable.
 *
 * Puerto efímero (`listen(0)`) para no chocar con nada del operador: el
 * gateway permite cualquier puerto de localhost, así que no hace falta fijarlo.
 */
function serveConsole(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const requested = new URL(req.url ?? '/', 'http://localhost').pathname
      const rel = requested === '/' ? '/gateway.html' : requested
      // Ancla el path dentro del dist: sin esto, un `..` en la URL leería
      // cualquier archivo de la máquina.
      const file = join(WEB_DIST, normalize(rel).replace(/^(\.\.[/\\])+/, ''))
      if (!file.startsWith(WEB_DIST) || !existsSync(file) || !statSync(file).isFile()) {
        res.writeHead(404).end('not found')
        return
      }
      res.writeHead(200, {
        'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
      })
      createReadStream(file).pipe(res)
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address && typeof address === 'object') resolve(`http://127.0.0.1:${address.port}`)
      else reject(new Error('el server de la consola no devolvió un puerto'))
    })
  })
}

/**
 * El bearer del gateway, leído de su propio `.env`.
 *
 * Es lo que evita que la ventana del gateway te pida un token que esta app ya
 * conoce: es el mismo proceso que ella levanta. Nunca sale de la máquina —
 * viaja al preload por argv y termina en el localStorage de esa ventana.
 */
function gatewayToken(): string | null {
  try {
    const env = readFileSync(join(REPO_ROOT, 'apps', 'ai-provider-gateway', '.env'), 'utf8')
    for (const line of env.split('\n')) {
      const [key, ...rest] = line.trim().split('=')
      if (key === 'API_AI_PROVIDER_TOKEN') return rest.join('=').replace(/^["']|["']$/g, '') || null
    }
  } catch {
    // Sin .env el gateway tampoco arrancaría con auth: la pantalla pide token.
  }
  return null
}

function parseMode(): Mode {
  const flag = process.argv.find((a) => a.startsWith('--mode='))?.split('=')[1]
  return flag === 'gateway' ? 'gateway' : 'web'
}

const mode = parseMode()
const config = MODES[mode]

// Los bundles ejecutan el binario pelado de Electron, así que sin esto el menú
// y el Dock dirían "Electron" (y mostrarían su ícono) en vez de los nuestros.
app.setName(config.title)
app.whenReady().then(() => {
  app.dock?.setIcon(join(app.getAppPath(), 'icons', `${config.icon}.png`))
})
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
 * Levanta el proceso del repo. El PATH se completa a mano porque una app
 * abierta desde el Finder arranca con el del sistema — sin `bun`, sin nada de
 * Homebrew.
 */
function startChild(): ChildProcess {
  const [cmd, ...args] = config.command
  const proc = spawn(cmd as string, args, {
    cwd: config.cwd,
    env: {
      ...process.env,
      ...config.env,
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

async function boot(): Promise<void> {
  const alreadyUp = await isPortTaken(config.port)
  // Si ya está corriendo (lo levantaste vos, u otra ventana), no se levanta un
  // segundo: se muestra el que hay. El puerto es de a uno.
  if (!alreadyUp) child = startChild()

  if (!(await waitForPort(config.port))) {
    dialog.showErrorBox(
      config.title,
      `No arrancó en :${config.port}.\n\n` +
        'Abrí la app desde una terminal para ver el log del proceso.',
    )
    app.quit()
    return
  }

  // Modo web: la SPA la sirve su propio dev server, como siempre.
  if (mode !== 'gateway') {
    createWindow(`http://localhost:${config.port}${config.path}`)
    return
  }

  // Modo gateway: la consola sale del bundle de la web, servida por esta app.
  // El gateway al que apunta viaja en la query — así la misma pantalla sirve
  // para el proceso local y para cualquier otro que el operador tipee.
  if (!existsSync(join(WEB_DIST, 'gateway.html'))) {
    dialog.showErrorBox(
      config.title,
      'Falta el bundle de la consola.\n\nCorré: bun run --cwd apps/web build',
    )
    app.quit()
    return
  }
  try {
    const consoleUrl = await serveConsole()
    createWindow(`${consoleUrl}/gateway.html?url=http://localhost:${config.port}`)
  } catch (err) {
    dialog.showErrorBox(config.title, `No pude servir la consola: ${String(err)}`)
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
