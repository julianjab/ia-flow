// Entrypoint de /Applications/IA Flow.app — corre al hacer doble clic, sin
// terminal a la vista.
//
// La regla de oro: un clic levanta LO ÚLTIMO que usaste, sin preguntar nada.
// Sólo pregunta cuando no tiene con qué decidir (primera vez, o el server que
// usaste la vez pasada ya no existe) o cuando pedís elegir a propósito
// (Option apretada al abrir, o `--choose`).
//
// Dos modos, un solo archivo: sin flags levanta la web (+gateway), y con
// `--gateway-only` levanta sólo el gateway. Cada uno tiene su .app.

import { GATEWAY_PORT, REPO_ROOT, TERMINAL_SCRIPT, TERMINAL_SCRIPT_GATEWAY } from './paths.ts'
import { type ServerTarget, discoverServers, isAlive, somethingListensOn } from './servers.ts'
import { type LauncherState, loadState, saveState } from './state.ts'
import { alert, chooseFromList, notify, openInTerminal, optionKeyHeld } from './ui.ts'

const SIN_GATEWAY = 'Sin gateway (sólo la web)'
const WEB_PORT_RANGE = { from: 5173, to: 5199 }

/**
 * Un puerto está libre sólo si lo está en los DOS stacks: Vite bindea ambos y
 * un dev server ajeno escuchando en [::1] no aparece si mirás sólo 127.0.0.1
 * (así elegíamos un puerto ya tomado y Vite moría con EADDRINUSE).
 */
function portFree(port: number): boolean {
  for (const hostname of ['127.0.0.1', '::1']) {
    try {
      Bun.listen({ hostname, port, socket: { data() {} } }).stop(true)
    } catch {
      return false
    }
  }
  return true
}

function pickWebPort(preferred?: number): number | null {
  if (preferred && portFree(preferred)) return preferred
  for (let port = WEB_PORT_RANGE.from; port <= WEB_PORT_RANGE.to; port++) {
    if (portFree(port)) return port
  }
  return null
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Enciende un runner apagado y espera a que su API conteste. */
async function startContainer(target: ServerTarget): Promise<boolean> {
  const dir = target.container?.composeDir
  if (!dir) return false
  notify(`Levantando ${target.container?.name}…`)
  const proc = Bun.spawnSync(['podman', 'compose', 'up', '-d'], { cwd: dir, stdout: 'ignore' })
  if (!proc.success) return false
  for (let i = 0; i < 40; i++) {
    if (await isAlive(target.url)) return true
    await Bun.sleep(500)
  }
  return false
}

/** El server para la web: el guardado si sigue vivo, si no un selector. */
async function resolveWebServer(
  servers: ServerTarget[],
  state: LauncherState,
  force: boolean,
): Promise<ServerTarget | null> {
  if (!force && state.webServer) {
    const saved = servers.find((s) => s.url === state.webServer)
    if (saved?.alive) return saved
  }
  if (servers.length === 0) {
    alert(
      'No encontré ningún server de ia-flow.\n\n' +
        'Levantá uno primero:\n' +
        '  • host:      bun run dev:server\n' +
        '  • container: podman compose up -d (en runners/<lo-que-sea>)',
    )
    return null
  }
  const label = chooseFromList(
    servers.map((s) => s.label),
    {
      title: 'IA Flow',
      prompt: '¿Contra qué server querés levantar la web?',
      defaultItem: servers.find((s) => s.url === state.webServer)?.label,
    },
  )
  return servers.find((s) => s.label === label) ?? null
}

/** El server contra el que se registra el gateway (o null si no lo querés). */
function resolveGatewayServer(
  servers: ServerTarget[],
  state: LauncherState,
  force: boolean,
): ServerTarget | null {
  if (!force && state.gatewayEnabled === false) return null
  if (!force && state.gatewayServer) {
    const saved = servers.find((s) => s.url === state.gatewayServer)
    if (saved) return saved
  }
  const label = chooseFromList([...servers.map((s) => s.label), SIN_GATEWAY], {
    title: 'IA Flow',
    prompt: '¿Contra qué server registro el provider gateway?',
    defaultItem: servers.find((s) => s.url === state.gatewayServer)?.label ?? SIN_GATEWAY,
  })
  if (!label || label === SIN_GATEWAY) return null
  return servers.find((s) => s.label === label) ?? null
}

/**
 * Por qué URL el server alcanza al gateway. Si el server vive en un
 * container, `localhost` apuntaría al container mismo — tiene que salir por
 * el gateway del host.
 */
function gatewayPublicUrl(server: ServerTarget): string {
  return server.container
    ? `http://host.containers.internal:${GATEWAY_PORT}`
    : `http://localhost:${GATEWAY_PORT}`
}

const gatewayOnly = Bun.argv.includes('--gateway-only')
const force = Bun.argv.includes('--choose') || optionKeyHeld()
const state = await loadState()

// ── Modo gateway suelto ────────────────────────────────────────────────────
// No toca la web ni su estado: sirve para registrar el gateway contra otro
// server sin reiniciar lo que ya tengas andando.
if (gatewayOnly) {
  if (await somethingListensOn(GATEWAY_PORT)) {
    alert(
      `Ya hay un gateway escuchando en :${GATEWAY_PORT}.\n\n` +
        'Bajalo primero (Ctrl+C en su ventana) y volvé a abrir esta app.',
    )
    process.exit(0)
  }

  const servers = (await discoverServers()).filter((s) => s.alive)
  if (servers.length === 0) {
    alert('No hay ningún server ia-flow respondiendo — el gateway no tendría dónde registrarse.')
    process.exit(0)
  }

  const target = resolveGatewayServer(servers, state, force)
  if (!target) process.exit(0)

  await saveState({ gatewayServer: target.url, gatewayEnabled: true })

  const cmd =
    `cd ${REPO_ROOT} && bun scripts/launcher/run.ts ` +
    `--gateway-server ${target.url} --gateway-public-url ${gatewayPublicUrl(target)}`
  if (!openInTerminal(cmd, TERMINAL_SCRIPT_GATEWAY)) {
    alert(`No pude abrir Terminal.\n\nCorrelo a mano:\n\n${cmd}`)
    process.exit(1)
  }
  process.exit(0)
}

// ¿Ya hay una sesión viva? Entonces esto es "traeme la ventana", no "levantá
// otra copia" — salvo que estés pidiendo elegir server de nuevo.
if (!force && state.running && isRunning(state.running.pid)) {
  Bun.spawn(['open', `http://localhost:${state.running.port}`])
  notify(`Ya estaba corriendo en :${state.running.port}`)
  process.exit(0)
}

const servers = await discoverServers()
const webServer = await resolveWebServer(servers, state, force)
if (!webServer) process.exit(0)

if (!webServer.alive && !(await startContainer(webServer))) {
  alert(
    `No pude levantar ${webServer.container?.name ?? webServer.url}.\n\nMirá los logs del container.`,
  )
  process.exit(1)
}

const gatewayServer = resolveGatewayServer(servers, state, force)
// El gateway es un solo proceso por máquina: si el puerto ya está tomado, hay
// uno andando y levantar otro sólo daría EADDRINUSE.
const gatewayAlreadyUp = gatewayServer !== null && (await somethingListensOn(GATEWAY_PORT))

const webPort = pickWebPort(state.webPort)
if (!webPort) {
  alert(`No hay puertos libres entre ${WEB_PORT_RANGE.from} y ${WEB_PORT_RANGE.to} para la web.`)
  process.exit(1)
}

await saveState({
  webServer: webServer.url,
  webPort,
  gatewayServer: gatewayServer?.url,
  gatewayEnabled: gatewayServer !== null,
})

const flags = [
  `--web-target ${webServer.url}`,
  `--web-port ${webPort}`,
  ...(gatewayServer && !gatewayAlreadyUp
    ? [
        `--gateway-server ${gatewayServer.url}`,
        `--gateway-public-url ${gatewayPublicUrl(gatewayServer)}`,
      ]
    : []),
]
const command = `cd ${REPO_ROOT} && bun scripts/launcher/run.ts ${flags.join(' ')}`
if (!openInTerminal(command, TERMINAL_SCRIPT)) {
  alert(`No pude abrir Terminal.\n\nCorrelo a mano:\n\n${command}`)
  process.exit(1)
}

if (gatewayAlreadyUp) notify(`Gateway ya corriendo en :${GATEWAY_PORT} — lo dejé como está`)
