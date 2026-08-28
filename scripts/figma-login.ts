#!/usr/bin/env bun
// Login OAuth (authorization code + PKCE) contra el MCP remoto de Figma
// (https://mcp.figma.com/mcp). Deja la sesión en
// ~/.config/ia-flow/figma-oauth.json y, a partir de ahí, el daemon expande
// `${FIGMA_TOKEN}` con un access token siempre vigente — lo renueva solo.
//
//   bun run auth:figma                     # login (abre el browser)
//   bun run auth:figma -- --status         # qué sesión hay guardada
//   bun run auth:figma -- --logout         # borra la sesión
//
// Flags:
//   --port=<n>            puerto del redirect local (default: 51789). Cambiarlo
//                         invalida el cliente ya registrado: su redirect_uri
//                         quedó fijado en el registro.
//   --client-id=<id>      app OAuth propia, para cuando el registro dinámico
//   --client-secret=<s>   de Figma no está habilitado (también por
//                         FIGMA_OAUTH_CLIENT_ID / FIGMA_OAUTH_CLIENT_SECRET)
//   --no-browser          sólo imprime la URL (SSH, WSL, headless)
import {
  DEFAULT_REDIRECT_PORT,
  FileTokenStore,
  runFigmaLogin,
  setLoggerFactory,
} from '@ia-flow/figma-auth'

const args = process.argv.slice(2)
const flag = (name: string): string | undefined =>
  args
    .find((a) => a.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=')
const has = (name: string): boolean => args.includes(`--${name}`)

// Un script de CLI habla por stdout, no por el log estructurado del daemon.
setLoggerFactory(() => ({
  info: () => {},
  debug: () => {},
  warn: (obj, msg) => console.warn(`⚠︎  ${msg ?? ''}`, obj),
  error: (obj, msg) => console.error(`✗  ${msg ?? ''}`, obj),
}))

const store = new FileTokenStore()

if (has('status')) {
  const session = await store.load()
  if (!session) {
    console.log(`Sin sesión de Figma en ${store.path}. Corré: bun run auth:figma`)
    process.exit(0)
  }
  const { expiresAt, refreshToken } = session.tokens
  console.log(`Sesión en ${store.path}`)
  console.log(`  client_id:  ${session.client.clientId}`)
  console.log(`  guardada:   ${session.updatedAt}`)
  console.log(
    `  access:     vence ${expiresAt ? new Date(expiresAt).toISOString() : 'sin declarar'}`,
  )
  console.log(
    `  refresh:    ${refreshToken ? 'sí (se renueva solo)' : 'NO — vas a tener que re-loguearte'}`,
  )
  process.exit(0)
}

if (has('logout')) {
  await store.clear()
  console.log(`Sesión borrada (${store.path}).`)
  process.exit(0)
}

try {
  const session = await runFigmaLogin({
    port: Number(flag('port') ?? DEFAULT_REDIRECT_PORT),
    clientId: flag('client-id'),
    clientSecret: flag('client-secret'),
    openBrowser: !has('no-browser'),
    store,
  })
  console.log(`\n✓ Listo. Sesión guardada en ${store.path}`)
  console.log(
    session.tokens.refreshToken
      ? '  El daemon renueva el access token solo.'
      : '  ⚠︎  Figma no devolvió refresh token: vas a tener que repetir esto cuando venza.',
  )
  console.log('\nAgregá el MCP al agente (editor de agentes → MCP servers):')
  console.log(
    JSON.stringify(
      {
        figma: {
          type: 'http',
          url: 'https://mcp.figma.com/mcp',
          authorizationToken: '${FIGMA_TOKEN}',
        },
      },
      null,
      2,
    ),
  )
} catch (err) {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
