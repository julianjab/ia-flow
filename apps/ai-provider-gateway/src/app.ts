// La API HTTP en sí — separada de src/index.ts (que solo la levanta con
// Bun.serve) para que los tests puedan llamar `app.request(...)` sin bindear
// un puerto real.
import type { IAgentProvider, ProviderInput, SessionHandle } from '@ia-flow/ai-providers'
import { WorkspaceRequestSchema, intersectWritePaths } from '@ia-flow/shared'
import { Hono } from 'hono'
import { type AdmissionRule, evaluateAdmission, isAdmissionRule } from './admission.js'
import { envCorsOrigins, isAllowedOrigin } from './cors.js'
import { readLogTail } from './log-tail.js'
import type { Log } from './logger.js'
import { type GatewayState, sanitizeWorkspace } from './state.js'

export interface CreateAppDeps {
  provider: IAgentProvider
  /** Bearer token esperado en `Authorization: Bearer <token>`. `undefined`
   *  = servidor mal configurado — se rechaza todo (nunca "sin auth"). */
  token: string | undefined
  log: Log
  /**
   * Cuántos runs simultáneos acepta esta instancia. `undefined` o `<= 0` =
   * sin límite (mismo criterio que los caps del server, ver capacity.ts en
   * @ia-flow/agent-engine).
   *
   * Este es el único lugar que conoce la ocupación REAL del gateway: un
   * mismo gateway puede estar registrado en varios daemons, y el cap que
   * cada daemon lleva por su cuenta (`ProviderConfig.providerLimits`) sólo
   * cuenta lo que despachó él. Por eso acá se enforcea de verdad (503 en
   * /v1/run) además de publicarse en /v1/capacity para que el daemon pueda
   * enrutar a otro provider antes de intentar.
   */
  maxConcurrentRuns?: number
  /**
   * Estado editable desde la pantalla: contra qué servers se registra, el cap
   * y las reglas de admisión. Se recibe por parámetro (y se persiste con
   * `onStateChange`) en vez de leerse acá, para que los tests puedan armar un
   * gateway con cualquier estado sin tocar el disco.
   */
  state?: GatewayState
  onStateChange?: (state: GatewayState) => void | Promise<void>
  /**
   * Construye un provider por id. Inyectado (y opcional) para que los tests
   * puedan cambiar de provider sin instanciar los reales — que abren clientes
   * HTTP y tocan el disco.
   */
  createProviderById?: (id: string, workspace: GatewayState['workspace']) => IAgentProvider
  /** Orígenes extra permitidos por CORS, además de localhost. Default:
   *  `GATEWAY_CORS_ORIGINS` (coma-separado). */
  extraCorsOrigins?: string[]
  /** Ids que la pantalla ofrece. Sin esto, no se puede cambiar. */
  availableProviderIds?: readonly string[]
  /** Alta/baja contra un server. Inyectado para poder testear sin red. */
  registerTo?: (
    serverUrls: string[],
    publicUrl?: string,
  ) => Promise<
    Array<{
      serverUrl: string
      ok: boolean
      reason?: string
      publicUrl?: string
      notAServer?: boolean
    }>
  >
  unregisterFrom?: (serverUrl: string) => Promise<unknown>
  /**
   * Cómo fue el alta de cada server, incluida la del boot. Se recibe por
   * referencia para que index.ts pueda volcar ahí el resultado del
   * self-registro sin que la app tenga que saber cuándo ocurrió.
   */
  registrationStatus?: Map<string, RegistrationOutcome>
  /**
   * Qué archivo sirve `GET /v1/logs`. Se recibe en vez de leerse de logger.js
   * porque es una decisión del proceso, no de la API: un gateway sin archivo
   * (el del Dockerfile) pasa `null` y la pantalla lo dice, y los tests pueden
   * apuntar a un archivo suyo sin tocar el HOME de nadie.
   */
  logFile?: string | null
}

function isProviderInput(body: unknown): body is ProviderInput {
  if (!body || typeof body !== 'object') return false
  const b = body as Record<string, unknown>
  return typeof b.taskId === 'string' && typeof b.prompt === 'string'
}

export interface RegistrationOutcome {
  serverUrl: string
  ok: boolean
  reason?: string
  /** Del otro lado no hay un server de ia-flow — no se recuerda esa URL. */
  notAServer?: boolean
  publicUrl?: string
  /** Cuándo se intentó, para distinguir "falló recién" de "falló al bootear". */
  at?: string
}

export function createApp({
  provider: initialProvider,
  token,
  log,
  maxConcurrentRuns,
  state: initialState,
  onStateChange,
  registerTo,
  unregisterFrom,
  registrationStatus = new Map<string, RegistrationOutcome>(),
  createProviderById,
  availableProviderIds = [],
  logFile = null,
  extraCorsOrigins = envCorsOrigins(Bun.env.GATEWAY_CORS_ORIGINS),
}: CreateAppDeps): Hono {
  const app = new Hono()

  // Mutable: la pantalla puede cambiarlo sin reiniciar. Un run en vuelo se
  // queda con el que le tocó — `provider.run()` ya fue invocado y su promesa
  // sigue su curso; el cambio sólo aplica a los runs siguientes.
  let provider = initialProvider

  // Estado vivo del proceso. `maxConcurrentRuns` del deps sigue siendo el
  // valor de arranque (el env), y el estado guardado lo pisa si existe: lo
  // que el operador eligió en la pantalla gana sobre el .env.
  const state: GatewayState = initialState ?? {
    registerServerUrls: [],
    providerId: null,
    maxConcurrentRuns: maxConcurrentRuns ?? null,
    admissionRules: [],
    workspace: { reposBase: null, worktreeBase: null, gitAuthorName: null, gitAuthorEmail: null },
  }

  async function persist(): Promise<void> {
    await onStateChange?.(state)
  }

  /**
   * Sesiones async vivas en ESTE proceso (un tmux, una tab de iTerm).
   *
   * Existe porque `SessionHandle` trae funciones (`isAlive`, `close`) que no
   * cruzan HTTP: al serializar la respuesta de /v1/run se pierden y del otro
   * lado llegan sólo sus coordenadas. El daemon las necesita igual —para el
   * watchdog de liveness y para cerrar la sesión al cancelar— así que se
   * guardan acá y se exponen como endpoints; el `RemoteAgentProvider`
   * reconstruye un handle que los llama.
   */
  const sessions = new Map<string, SessionHandle>()

  // Runs en vuelo en ESTE proceso. Se incrementa al entrar a /v1/run y se
  // libera en un finally, así un provider que lanza no deja el contador
  // envenenado.
  let running = 0
  const capOf = () => state.maxConcurrentRuns
  const isUnlimited = () => {
    const cap = capOf()
    return cap == null || cap <= 0
  }

  // Un solo lugar decide si esta instancia puede tomar trabajo, y devuelve el
  // MOTIVO junto con la respuesta: el daemon lo loguea tal cual, así un
  // "diferido" del otro lado del cable explica por qué. Acá es donde va un
  // chequeo nuevo (RAM libre, carga del host, trabajo local en curso) — el
  // gateway es el único que conoce ese estado.
  const capacity = (
    subject: {
      repos?: string[]
      agentId?: string
      projectId?: string
      taskType?: string
      assignees?: string[]
    } = {},
  ): { accepting: boolean; reason?: string } => {
    const cap = capOf()
    if (!isUnlimited() && running >= (cap as number)) {
      return { accepting: false, reason: `runs en curso al tope (${running}/${cap})` }
    }
    // Las reglas se evalúan con lo que haya: en /v1/capacity puede no venir
    // nada (es una sonda sin cuerpo) y ahí sólo filtran las que apliquen. La
    // evaluación completa ocurre en /v1/run, que tiene la tarea entera.
    return evaluateAdmission(state.admissionRules, subject)
  }

  // La consola vive en otro origen (la sirve la app de Electron, o el dev
  // server de Vite), así que el browser hace preflight antes de cada PUT con
  // Authorization. Se refleja el Origin sólo si está permitido —nunca `*`—
  // para que una página cualquiera de internet no pueda hablarle a este
  // proceso desde el browser del operador. Con bearer obligatorio el riesgo
  // ya era acotado; esto cierra también la lectura de respuestas.
  app.use('*', async (c, next) => {
    const origin = c.req.header('origin')
    if (origin && isAllowedOrigin(origin, extraCorsOrigins)) {
      c.header('access-control-allow-origin', origin)
      c.header('vary', 'Origin')
      c.header('access-control-allow-headers', 'authorization, content-type')
      c.header('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS')
      c.header('access-control-max-age', '600')
    }
    // El preflight viaja SIN Authorization por definición: contestarlo antes
    // del middleware de auth es lo que evita que muera con 401.
    if (c.req.method === 'OPTIONS') return c.body(null, 204)
    await next()
  })

  // `GET /` ya no sirve una pantalla: la consola es la de apps/web
  // (`gateway.html`), servida por la app de Electron o por Vite. Devolver una
  // pista es más útil que un 404 para quien abra este puerto en el browser.
  app.get('/', (c) =>
    c.json({
      service: 'ai-provider-gateway',
      ui: 'la consola es apps/web (gateway.html) — apuntala a esta URL',
    }),
  )

  app.use('*', async (c, next) => {
    if (!token) {
      log.error({}, 'API_AI_PROVIDER_TOKEN no configurado — rechazando todo')
      return c.json({ error: 'server misconfigured: no auth token set' }, 500)
    }
    const header = c.req.header('authorization') ?? ''
    const provided = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
    if (provided !== token) return c.json({ error: 'unauthorized' }, 401)
    await next()
  })

  // GET /v1/provider — para que el registro del server principal valide que
  // esta instancia responde antes de guardar la registración. No expone un
  // "id" a elegir: cuál provider concreto corre acá es decisión interna de
  // esta instancia (ver providers.ts).
  app.get('/v1/provider', (c) => {
    return c.json({
      kind: provider.kind,
      name: provider.name,
      description: provider.description,
      // Lo que la pantalla necesita para ofrecer el cambio. El server principal
      // ignora estos campos: qué provider concreto corre acá le da igual.
      id: state.providerId ?? provider.id,
      available: availableProviderIds,
    })
  })

  app.put('/v1/provider', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { id?: unknown } | null
    const id = typeof body?.id === 'string' ? body.id : ''
    if (!availableProviderIds.includes(id)) {
      return c.json({ error: `provider desconocido: "${id}"` }, 400)
    }
    if (!createProviderById)
      return c.json({ error: 'este gateway no puede cambiar de provider' }, 400)

    provider = createProviderById(id, state.workspace)
    state.providerId = id
    await persist()

    // El server guardó nombre y descripción CUANDO se registró: sin volver a
    // darse de alta seguiría anunciando el provider viejo, y el operador vería
    // en la web del server algo distinto de lo que este gateway ejecuta.
    const results = state.registerServerUrls.length
      ? ((await registerTo?.(state.registerServerUrls)) ?? [])
      : []
    for (const result of results) {
      registrationStatus.set(result.serverUrl, { ...result, at: new Date().toISOString() })
    }

    log.info({ id, reRegistered: results.length }, 'provider cambiado desde la pantalla')
    return c.json({
      id,
      kind: provider.kind,
      name: provider.name,
      description: provider.description,
      available: availableProviderIds,
    })
  })

  // GET /v1/capacity — sonda barata para que el daemon sepa, ANTES de
  // mandar el run, si esta instancia puede tomarlo. Consultiva: no reserva
  // nada (ver IAgentProvider.canAccept). La decisión firme es el 503 de
  // /v1/run.
  app.get('/v1/capacity', (c) => {
    // Pistas opcionales por query: el daemon manda lo que sabe de la tarea
    // (repo, agente) para que las reglas se puedan evaluar ANTES del
    // dispatch. Un daemon viejo no las manda y todo sigue igual.
    const repos = c.req.queries('repo')
    // `assignee=` vacío es el marcador de "conocido y sin asignar" (ver
    // RemoteAgentProvider.canAccept): presente → la lista real es los valores
    // no vacíos, aunque queden cero. Ausente → no se sabe, la regla se saltea.
    const rawAssignees = c.req.queries('assignee')
    const { accepting, reason } = capacity({
      repos: repos?.length ? repos : undefined,
      agentId: c.req.query('agentId'),
      projectId: c.req.query('projectId'),
      taskType: c.req.query('taskType'),
      assignees: rawAssignees?.length ? rawAssignees.filter((v) => v !== '') : undefined,
    })
    return c.json({
      running,
      maxConcurrentRuns: isUnlimited() ? null : capOf(),
      accepting,
      reason,
    })
  })

  // ── Lo editable desde la pantalla ────────────────────────────────────────

  app.get('/v1/admission', (c) =>
    c.json({ maxConcurrentRuns: state.maxConcurrentRuns, rules: state.admissionRules }),
  )

  app.put('/v1/admission', async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      maxConcurrentRuns?: unknown
      rules?: unknown
    } | null
    if (!body) return c.json({ error: 'invalid JSON body' }, 400)

    if ('maxConcurrentRuns' in body) {
      const raw = body.maxConcurrentRuns
      if (raw !== null && (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0)) {
        return c.json({ error: 'maxConcurrentRuns debe ser un número >= 0, o null' }, 400)
      }
      // 0 se guarda como null: "sin tope", el mismo criterio que el engine.
      state.maxConcurrentRuns = raw === null || raw === 0 ? null : (raw as number)
    }

    if ('rules' in body) {
      if (!Array.isArray(body.rules) || !body.rules.every(isAdmissionRule)) {
        return c.json({ error: 'rules debe ser una lista de {field, op, value}' }, 400)
      }
      state.admissionRules = body.rules as AdmissionRule[]
    }

    await persist()
    log.info(
      { maxConcurrentRuns: state.maxConcurrentRuns, rules: state.admissionRules.length },
      'admisión actualizada desde la pantalla',
    )
    return c.json({ maxConcurrentRuns: state.maxConcurrentRuns, rules: state.admissionRules })
  })

  // Devuelve el ESTADO, no la intención: la lista de servers configurados es
  // sólo la mitad, y mostrarla sola hacía que la pantalla dijera "registrado
  // en X" mientras el alta venía fallando en silencio.
  // GET /v1/logs — el final del archivo, para la card de logs de la pantalla.
  //
  // El filtro corre ACÁ, sobre el archivo, y no en el navegador sobre lo ya
  // devuelto: filtrar lo que entró en la última página encontraría los
  // errores salvo justo los que uno busca, que son los viejos. Ver
  // log-tail.ts.
  // GET/PUT /v1/workspace — dónde aterriza el trabajo en esta máquina.
  //
  // Es lo que antes sólo se podía cambiar editando el `.env` y reiniciando.
  // Un PUT reconstruye el provider en caliente: el WorkspaceManager toma sus
  // paths al construirse, así que sin rehacerlo el valor nuevo no llegaría a
  // los runs siguientes. Los runs EN VUELO se quedan con el suyo — su
  // `prepareWorkspace` ya corrió.
  app.get('/v1/workspace', (c) => c.json(state.workspace))

  app.put('/v1/workspace', async (c) => {
    const body = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object') return c.json({ error: 'body inválido' }, 400)

    state.workspace = sanitizeWorkspace(body, state.workspace)
    await persist()

    if (createProviderById) {
      provider = createProviderById(state.providerId ?? provider.id, state.workspace)
    }
    log.info({ ...state.workspace }, 'workspace cambiado desde la consola')
    return c.json(state.workspace)
  })

  app.get('/v1/logs', async (c) => {
    const limit = Number.parseInt(c.req.query('limit') ?? '', 10)
    return c.json(
      await readLogTail({
        file: logFile,
        limit: Number.isFinite(limit) ? limit : 200,
        query: c.req.query('q') ?? '',
        log,
      }),
    )
  })

  // ── Sesiones async ───────────────────────────────────────────────────────
  // El daemon pregunta por ellas mientras espera el callback del agente.

  app.get('/v1/sessions/:id', async (c) => {
    const session = sessions.get(c.req.param('id'))
    // Una sesión que no conocemos se reporta muerta, no 404: para el watchdog
    // del daemon significan lo mismo (dejá de esperarla) y un 404 lo obligaría
    // a distinguir dos casos que no cambian su decisión. Pasa de verdad si el
    // gateway reinició mientras la sesión corría.
    if (!session) return c.json({ alive: false, known: false })
    try {
      return c.json({ alive: await session.isAlive(), known: true })
    } catch (err) {
      log.warn({ err: String(err), id: session.id }, 'isAlive falló — la doy por muerta')
      return c.json({ alive: false, known: true })
    }
  })

  app.delete('/v1/sessions/:id', async (c) => {
    const id = c.req.param('id')
    const session = sessions.get(id)
    if (session) {
      // `close()` es idempotente por contrato (ver SessionHandle): el watchdog
      // y el cancel manual pueden llegar los dos.
      await session.close().catch((err) => {
        log.warn({ err: String(err), id }, 'close falló')
      })
      sessions.delete(id)
    }
    return c.json({ closed: true })
  })

  app.get('/v1/registrations', (c) =>
    c.json({
      serverUrls: state.registerServerUrls,
      registrations: state.registerServerUrls.map(
        (serverUrl) =>
          registrationStatus.get(serverUrl) ?? { serverUrl, ok: false, reason: 'sin intentar' },
      ),
    }),
  )

  app.post('/v1/registrations', async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      serverUrl?: unknown
      publicUrl?: unknown
    } | null
    const serverUrl = typeof body?.serverUrl === 'string' ? body.serverUrl.trim() : ''
    if (!serverUrl) return c.json({ error: 'falta serverUrl' }, 400)
    const publicUrl = typeof body?.publicUrl === 'string' ? body.publicUrl.trim() : undefined

    const [result] = (await registerTo?.([serverUrl], publicUrl)) ?? []
    const outcome: RegistrationOutcome = {
      serverUrl,
      ok: result?.ok ?? false,
      reason: result?.reason,
      notAServer: result?.notAServer,
      publicUrl: result?.publicUrl ?? publicUrl,
      at: new Date().toISOString(),
    }

    // Una URL donde no hay un server no se recuerda: reintentarla en cada
    // arranque no va a cambiar nada y la lista se llenaría de filas rojas que
    // hay que limpiar a mano. Un fallo normal (server abajo, todavía
    // arrancando) sí se recuerda — ahí reintentar tiene sentido.
    if (outcome.notAServer) {
      log.warn({ serverUrl, reason: outcome.reason }, 'no hay un server de ia-flow en esa URL')
      return c.json({ serverUrls: state.registerServerUrls, registration: outcome }, 400)
    }

    registrationStatus.set(serverUrl, outcome)
    if (!state.registerServerUrls.includes(serverUrl)) {
      state.registerServerUrls = [...state.registerServerUrls, serverUrl]
      await persist()
    }
    log.info(
      { serverUrl, ok: outcome.ok, reason: outcome.reason },
      'registro pedido desde la pantalla',
    )
    return c.json({ serverUrls: state.registerServerUrls, registration: outcome })
  })

  app.delete('/v1/registrations', async (c) => {
    const serverUrl = c.req.query('serverUrl')?.trim()
    if (!serverUrl) return c.json({ error: 'falta ?serverUrl=' }, 400)

    // Se da de baja SIEMPRE, aunque no esté en la lista: puede haber quedado
    // una registración vieja en ese server de un arranque anterior.
    const result = await unregisterFrom?.(serverUrl)
    state.registerServerUrls = state.registerServerUrls.filter((u) => u !== serverUrl)
    registrationStatus.delete(serverUrl)
    await persist()
    log.info({ serverUrl }, 'baja pedida desde la pantalla')
    return c.json({ serverUrls: state.registerServerUrls, result })
  })

  /**
   * Por dónde alcanza al daemon el agente que corre en ESTA máquina.
   *
   * El server no puede saberlo —`localhost` para él es él mismo— pero nosotros
   * sí: es la URL con la que nos registramos, y que por definición funciona
   * desde acá porque el alta viajó por ella.
   *
   * Con varios servers registrados no hay forma de saber cuál despachó este
   * run, así que ahí se respeta lo que haya mandado el server (su
   * `IA_FLOW_DAEMON_PUBLIC_URL`). Con uno solo —el caso normal— no hace falta
   * configurar nada de aquel lado.
   */
  function daemonUrlFor(input: ProviderInput): string | undefined {
    const [only, ...rest] = state.registerServerUrls
    if (only && rest.length === 0) return only
    return input.daemonUrl
  }

  /**
   * Aterriza el `workspace` del input sobre ESTE disco antes de correr.
   *
   * Es la pieza que hace que un provider remoto pueda trabajar sobre un repo:
   * el daemon que origina el dispatch manda coordenadas (repo, branch, si el
   * agente escribe), no paths de su máquina, y acá el provider resuelve los
   * suyos — clonando el repo si nunca lo vio.
   *
   * Fail-open a propósito: si el provider no implementa `prepareWorkspace`, o
   * el request no trae `workspace`, el input pasa tal cual (comportamiento de
   * un gateway sin filesystem de proyecto, que es lo único que había antes).
   * Un fallo de la preparación SÍ se propaga: correr igual dejaría al agente
   * escribiendo en un lugar que nadie eligió.
   */
  async function resolveWorkspace(input: ProviderInput): Promise<ProviderInput> {
    if (!input.workspace || !provider.prepareWorkspace) return input
    // Viene del otro lado del cable: se valida en el borde.
    const req = WorkspaceRequestSchema.parse(input.workspace)
    const plan = await provider.prepareWorkspace(req)
    log.info(
      { taskId: input.taskId, cwd: plan.cwd, worktree: plan.worktreePath },
      'Workspace preparado localmente para un run remoto',
    )
    return {
      ...input,
      repoPaths: { ...plan.repoPaths },
      cwd: plan.cwd ?? input.cwd,
      // El permiso sigue siendo del engine que despachó (`needsWrite` viaja en
      // el request); acá sólo se resuelve DÓNDE.
      writePaths: intersectWritePaths(plan.writePaths, req.needsWrite),
      branch: plan.branch ?? input.branch,
    }
  }

  app.post('/v1/run', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400)
    }
    if (!isProviderInput(body)) {
      return c.json({ error: 'body must be a ProviderInput (needs at least taskId, prompt)' }, 400)
    }

    // Saturado: 503, no 500. Es "volvé después", no "esto falló" — el
    // daemon lo difiere y reintenta cuando se libera un slot, en vez de
    // marcar el run como error.
    const { accepting, reason } = capacity({
      repos: body.repos,
      agentId: body.agentId,
      projectId: body.projectId,
      taskType: body.taskType,
      assignees: body.assignees,
    })
    if (!accepting) {
      log.warn(
        { running, maxConcurrentRuns: capOf(), reason, taskId: body.taskId },
        'no tomo este run — 503',
      )
      return c.json(
        { error: reason ?? 'gateway at capacity', running, maxConcurrentRuns: capOf() },
        503,
      )
    }

    running++
    try {
      const output = await provider.run({
        ...(await resolveWorkspace(body)),
        daemonUrl: daemonUrlFor(body),
      })

      // Un provider async devuelve apenas lanzó la sesión: el resultado real
      // llega después, por el callback del agente al daemon. Lo único que
      // viaja en la respuesta son las coordenadas de esa sesión.
      if (output.session) sessions.set(output.session.id, output.session)

      return c.json(output)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error({ err: message, taskId: body.taskId }, 'provider run failed')
      return c.json({ error: message }, 500)
    } finally {
      running--
    }
  })

  return app
}
