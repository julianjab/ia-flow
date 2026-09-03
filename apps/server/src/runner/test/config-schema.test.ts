import { describe, expect, it } from 'bun:test'
import { RunnerConfigSchema } from '../config-schema.js'

const minimal = {
  projects: [
    {
      id: 'la-haus',
      name: 'la-haus',
      source: {
        kind: 'github-projects',
        config: { url: 'https://github.com/orgs/la-haus/projects/119' },
      },
    },
  ],
}

describe('RunnerConfigSchema', () => {
  it('un proyecto alcanza — el resto de las secciones son opcionales', () => {
    const parsed = RunnerConfigSchema.parse(minimal)
    // Defaults a lista vacía, no undefined: el loader las recorre sin guardas.
    expect(parsed.repos).toEqual([])
    expect(parsed.agents).toEqual([])
    expect(parsed.mcp).toEqual([])
    expect(parsed.settings).toBeUndefined()
  })

  it('acepta cero proyectos inline — pueden venir todos de la carpeta projects/', () => {
    // El "al menos uno" NO vive acá: el schema valida el archivo, y los
    // proyectos pueden estar enteros en `projects/`. Lo chequea el loader
    // sobre el resultado del merge (ver su test), que es el único lugar donde
    // la pregunta tiene sentido.
    expect(RunnerConfigSchema.safeParse({ ...minimal, projects: [] }).success).toBe(true)
  })

  it('un repo del catálogo no necesita `path`', () => {
    // La razón de ser del flavor: el catálogo mapea nombre corto → coordenadas
    // de GitHub para que el agente sepa qué repo es cuál. El `path` sólo lo
    // consume un provisioner de workspace, que este flavor no inyecta.
    const parsed = RunnerConfigSchema.parse({
      ...minimal,
      repos: [
        {
          name: 'subscriptions',
          projectId: 'la-haus',
          githubOwner: 'la-haus',
          githubRepo: 'subscriptions',
        },
      ],
    })
    expect(parsed.repos[0]?.path).toBeUndefined()
  })

  it('rechaza un knob de settings desconocido en vez de ignorarlo', () => {
    // El motivo de declarar cada knob con nombre propio en lugar de un `env: {}`
    // crudo: un típo tiene que romper el boot, no quedar como una variable que
    // nunca se aplicó.
    const typo = RunnerConfigSchema.safeParse({
      ...minimal,
      settings: { maxConcurrenDispatches: 3 },
    })
    expect(typo.success).toBe(false)

    const badValue = RunnerConfigSchema.safeParse({
      ...minimal,
      settings: { daemonMode: 'webhoook' },
    })
    expect(badValue.success).toBe(false)
  })

  it('acepta remoteProviders — el knob que apaga el self-registro de agent-hosts', () => {
    // Regresión: el campo llegó al flavor antes que al schema, así que
    // `.strict()` habría rechazado el runner.yaml que intentara declararlo.
    // A runtime no fallaba (`?? true` lo tapaba), sólo era imposible de usar.
    const parsed = RunnerConfigSchema.parse({ ...minimal, settings: { remoteProviders: false } })
    expect(parsed.settings?.remoteProviders).toBe(false)
  })

  it('acepta workspace — el knob que le da checkout al roster que escribe', () => {
    // Mismo patrón que `remoteProviders`: no mapea a ninguna env var, lo lee
    // el flavor directo de la config (entry/runner.ts) y se lo pasa al
    // container. Si el schema no lo conociera, `.strict()` rechazaría el
    // runner.yaml del deploy que lo declara y el boot moriría con un error de
    // validación en vez de prender el provisioner.
    const parsed = RunnerConfigSchema.parse({ ...minimal, settings: { workspace: true } })
    expect(parsed.settings?.workspace).toBe(true)

    // Ausente ⇒ undefined, no `false`: el default lo pone el flavor
    // (`?? false`), no el schema — duplicarlo acá es exactamente lo que el
    // comentario de RunnerSettingsSchema prohíbe.
    expect(RunnerConfigSchema.parse(minimal).settings?.workspace).toBeUndefined()
  })

  it('acepta websocket — el knob que abre /ws en el flavor runner', () => {
    // Mismo patrón que `remoteProviders`/`workspace`: no mapea a ninguna env
    // var, lo lee runner-boot.ts directo de la config (junto con `api`, que
    // decide si el WS realmente se monta).
    const parsed = RunnerConfigSchema.parse({ ...minimal, settings: { websocket: true } })
    expect(parsed.settings?.websocket).toBe(true)

    // Ausente ⇒ undefined: el default (apagado) lo pone el flavor, no el
    // schema.
    expect(RunnerConfigSchema.parse(minimal).settings?.websocket).toBeUndefined()
  })

  it('valida que `upstream.url` sea una URL', () => {
    expect(
      RunnerConfigSchema.safeParse({ ...minimal, upstream: { url: 'localhost:3001' } }).success,
    ).toBe(false)
    expect(
      RunnerConfigSchema.safeParse({ ...minimal, upstream: { url: 'http://localhost:3001' } })
        .success,
    ).toBe(true)
  })

  it('acepta el bloque github sin secretos — sólo el path del PEM', () => {
    const parsed = RunnerConfigSchema.parse({
      ...minimal,
      github: {
        mode: 'github-app',
        appId: '123456',
        privateKeyPath: '/run/secrets/github-app.pem',
      },
    })
    expect(parsed.github?.mode).toBe('github-app')
    // No hay campo donde meter el PEM inline: el runner.yaml es commiteable.
    expect(parsed.github).not.toHaveProperty('privateKey')
  })
})
