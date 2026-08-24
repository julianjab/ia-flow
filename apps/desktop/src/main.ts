// El proceso principal de las apps de escritorio.
//
// Un solo archivo para las dos, porque hacen lo mismo con distinto contenido:
// levantar un proceso del repo y mostrar SU web en una ventana. El modo llega
// por `--mode` (lo fija cada bundle en install.sh).
//
//   web      → `bun run dev:web` + la SPA, que arranca en el selector de server
//   gateway  → el gateway + su pantalla de /
//
// Por qué no hay diálogos nativos acá: elegir server y configurar el gateway
// ya son pantallas web que existen y están testeadas. Duplicarlas en Electron
// sería mantener dos veces la misma decisión.

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join } from 'node:path'
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
  command: string[]
  cwd: string
  env: Record<string, string>
}

const MODES: Record<Mode, ModeConfig> = {
  web: {
    title: 'IA Flow',
    port: 5273,
    path: '/servers',
    command: ['bun', 'run', 'dev:web'],
    cwd: REPO_ROOT,
    env: { IA_FLOW_WEB_PORT: '5273' },
  },
  gateway: {
    title: 'IA Flow Gateway',
    port: 3002,
    path: '/',
    command: ['bun', 'run', 'src/index.ts'],
    cwd: join(REPO_ROOT, 'apps', 'ai-provider-gateway'),
    env: {},
  },
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
  app.dock?.setIcon(join(app.getAppPath(), 'icons', 'AppIcon.png'))
})
let child: ChildProcess | null = null

/**
 * ¿Hay algo escuchando ahí?
 *
 * Un TCP connect, no un bind de prueba: bindear puede tener éxito aunque otro
 * proceso esté sirviendo el mismo puerto (reuse de socket), y ahí el hijo
 * muere con EADDRINUSE. Si ya hay algo, esta app se cuelga de eso en vez de
 * levantar un duplicado.
 */
function isPortTaken(port: number, timeoutMs = 600): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const done = (taken: boolean) => {
      socket.destroy()
      resolve(taken)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
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

  const url = `http://localhost:${config.port}${config.path}`
  if (!(await waitForPort(config.port))) {
    dialog.showErrorBox(
      config.title,
      `No arrancó en :${config.port}.\n\n` +
        'Abrí la app desde una terminal para ver el log del proceso.',
    )
    app.quit()
    return
  }
  createWindow(url)
}

app.whenReady().then(boot)

app.on('window-all-closed', () => app.quit())

// El hijo es nuestro: si se va la app sin matarlo queda un Vite (o un gateway)
// huérfano ocupando el puerto, y el próximo arranque se cuelga de un proceso
// que ya nadie supervisa.
app.on('before-quit', () => child?.kill())
