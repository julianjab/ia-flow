// El proceso que queda vivo en la ventana de Terminal: levanta la web (Vite)
// y/o el provider gateway, con los logs de los dos prefijados en la misma
// ventana. Ctrl+C acá baja todo.
//
// Las dos partes son opcionales por separado: IA Flow.app pide web (+gateway)
// y IA Flow Gateway.app pide sólo gateway.
//
// No lo invocás a mano — lo abre launch.ts con los flags ya resueltos.
// Los secretos (tokens del gateway) NUNCA viajan por argv: este proceso lee
// apps/ai-provider-gateway/.env por su cuenta y arma el env del hijo.

import { GATEWAY_DIR, GATEWAY_PORT, REPO_ROOT } from './paths.ts'
import { somethingListensOn } from './servers.ts'
import { saveState } from './state.ts'

type Args = {
  webTarget?: string
  webPort?: number
  gatewayServer?: string
  gatewayPublicUrl?: string
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string) => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const webTarget = get('--web-target')
  const rawPort = get('--web-port')
  const webPort = rawPort === undefined ? undefined : Number(rawPort)
  const gatewayServer = get('--gateway-server')

  if (webTarget && !Number.isInteger(webPort)) {
    throw new Error('--web-target necesita también --web-port')
  }
  if (!webTarget && !gatewayServer) {
    throw new Error('uso: run.ts [--web-target <url> --web-port <n>] [--gateway-server <url>]')
  }

  return { webTarget, webPort, gatewayServer, gatewayPublicUrl: get('--gateway-public-url') }
}

/** Parser mínimo de .env — sin dependencias, mismo formato que lee Bun. */
async function readEnvFile(path: string): Promise<Record<string, string>> {
  const env: Record<string, string> = {}
  let text: string
  try {
    text = await Bun.file(path).text()
  } catch {
    return env
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    env[key] = value
  }
  return env
}

const COLORS = { web: '\x1b[36m', gateway: '\x1b[35m', reset: '\x1b[0m' }

/** Reenvía el stream de un hijo a nuestra stdout, una línea a la vez, prefijada. */
async function pipePrefixed(stream: ReadableStream<Uint8Array>, tag: 'web' | 'gateway') {
  const prefix = `${COLORS[tag]}[${tag}]${COLORS.reset} `
  const decoder = new TextDecoder()
  let buffered = ''
  for await (const chunk of stream) {
    buffered += decoder.decode(chunk, { stream: true })
    const lines = buffered.split('\n')
    buffered = lines.pop() ?? ''
    for (const line of lines) process.stdout.write(`${prefix}${line}\n`)
  }
  if (buffered) process.stdout.write(`${prefix}${buffered}\n`)
}

async function waitForPort(port: number, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(500) })
      return true
    } catch {
      await Bun.sleep(300)
    }
  }
  return false
}

const args = parseArgs(Bun.argv.slice(2))
const children: Bun.Subprocess[] = []

// launch.ts ya mira el puerto, pero entre aquel chequeo y este spawn pasan
// segundos: abrir las dos apps en esa ventana hacía que ambas lo vieran libre
// y la segunda muriera con un EADDRINUSE crudo. Chequear acá no elimina la
// carrera (nada salvo bindear lo haría), pero la reduce a milisegundos y
// convierte el caso común en un mensaje entendible.
if (args.gatewayServer && (await somethingListensOn(GATEWAY_PORT))) {
  process.stdout.write(
    `\n  · ya hay un gateway escuchando en :${GATEWAY_PORT} — lo dejo como está.\n` +
      '    Para reapuntarlo a otro server, bajá ese primero (Ctrl+C en su ventana).\n\n',
  )
  args.gatewayServer = undefined
}

if (args.gatewayServer) {
  const fileEnv = await readEnvFile(`${GATEWAY_DIR}/.env`)
  // Sin `--watch` a propósito: un gateway que se reinicia solo al guardar un
  // archivo se re-registra contra el server en cada save y hace ruido difícil
  // de leer en la ventana. Para tomar un cambio, Ctrl+C y volvé a abrir la app.
  const gateway = Bun.spawn(['bun', 'run', 'src/index.ts'], {
    cwd: GATEWAY_DIR,
    env: {
      ...process.env,
      ...fileEnv,
      // Lo único que el launcher decide por encima del .env: contra qué server
      // se registra y por qué URL ese server lo alcanza de vuelta.
      IA_FLOW_REGISTER_SERVER_URLS: args.gatewayServer,
      ...(args.gatewayPublicUrl ? { IA_FLOW_GATEWAY_PUBLIC_URL: args.gatewayPublicUrl } : {}),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  children.push(gateway)
  void pipePrefixed(gateway.stdout as ReadableStream<Uint8Array>, 'gateway')
  void pipePrefixed(gateway.stderr as ReadableStream<Uint8Array>, 'gateway')
}

const web =
  args.webTarget && args.webPort
    ? Bun.spawn(['bun', 'run', 'dev:web'], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          VITE_API_TARGET: args.webTarget,
          IA_FLOW_WEB_PORT: String(args.webPort),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
    : null
if (web) {
  children.push(web)
  void pipePrefixed(web.stdout as ReadableStream<Uint8Array>, 'web')
  void pipePrefixed(web.stderr as ReadableStream<Uint8Array>, 'web')
}

async function shutdown() {
  for (const child of children) child.kill()
  await saveState({ running: null })
  process.exit(0)
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())

// El registro de "hay algo corriendo" es de la web: es lo que hace que un
// segundo clic abra el navegador en vez de levantar otro Vite. Un run de sólo
// gateway no tiene navegador que traer al frente.
if (web && args.webTarget && args.webPort) {
  await saveState({
    running: { pid: process.pid, port: args.webPort, webServer: args.webTarget },
  })
}

if (web && args.webPort) {
  if (await waitForPort(args.webPort)) {
    Bun.spawn(['open', `http://localhost:${args.webPort}`])
    process.stdout.write(`\n  ▸ web:     http://localhost:${args.webPort}\n`)
    process.stdout.write(`  ▸ API:     ${args.webTarget}\n`)
    if (args.gatewayServer) process.stdout.write(`  ▸ gateway: → ${args.gatewayServer}\n`)
    process.stdout.write('\n  Ctrl+C acá baja todo.\n\n')
  } else {
    process.stdout.write(
      `\n  ✗ la web no respondió en :${args.webPort} — mirá el log de arriba.\n\n`,
    )
  }
} else if (args.gatewayServer) {
  process.stdout.write(`\n  ▸ gateway: :${GATEWAY_PORT} → registrado en ${args.gatewayServer}\n`)
  process.stdout.write('\n  Ctrl+C acá lo baja.\n\n')
} else {
  // Sin web y sin gateway: lo pedido ya estaba corriendo. El mensaje de por
  // qué ya se imprimió arriba; no hay nada que supervisar.
  await shutdown()
}

// Se espera al proceso que define la sesión: la web si la hay, si no el
// gateway. Sin esto un run de sólo gateway saldría de inmediato y el shutdown
// del finally mataría al gateway recién levantado.
await (web ?? children[0])?.exited
await shutdown()
