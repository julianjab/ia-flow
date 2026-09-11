// La API HTTP en sí — separada de src/index.ts (que solo la levanta con
// Bun.serve) para que los tests puedan llamar `app.request(...)` sin bindear
// un puerto real.
import { timingSafeEqual } from 'node:crypto'
import type { IAgentProvider, Liveness, ProviderInput, SessionHandle } from '@ia-flow/ai-providers'
import { itermSessionHandle, tmuxSessionHandle } from '@ia-flow/ai-providers'
import { intersectWritePaths, WorkspaceRequestSchema } from '@ia-flow/shared'
import type { CompiledPolicy, JsonRpcRequest, McpResponse, McpServerDeps } from '@ia-flow/tools'
import { handleMcpRequest, mcpNoStream, mcpParseError } from '@ia-flow/tools'
import { type Context, Hono } from 'hono'
import { type AdmissionRule, evaluateAdmission, isAdmissionRule } from './admission.js'
import { envCorsOrigins, isAllowedOrigin } from './cors.js'
import { readLogTail } from './log-tail.js'
import { clearRunLogTarget, type Log, setRunLogTarget } from './logger.js'
import { type AgentHostState, sanitizeSystemPrompt, sanitizeWorkspace } from './state.js'

/** El disco de un run: lo que `/v1/mcp` le da al `ToolContext` para que una
 *  tool de filesystem opere sobre el workspace de ESTE run y no sobre otro. */
interface RunWorkspace {
  repoPaths: Record<string, string>
  writePaths?: string[]
  taskId?: string
  /**
   * La policy compilada que llegó en el `ProviderInput`. Sin ella `bash_run`
   * no tiene sus patrones allow/deny y rechaza TODO comando con "no
   * habilitado" — la tool quedaría ofrecida y muerta.
   */
  policy?: CompiledPolicy
}

/**
 * Rehidrata la policy que llegó por el cable.
 *
 * `JSON.stringify` no tiene Set: `RemoteAgentProvider` manda `toolNames` como
 * array (y un Set sin convertir colapsa a `{}`). Mismo criterio que
 * `resolveAnthropicPolicy` — ante cualquier otra forma, allow-list vacía en
 * vez de romper.
 */
function rehydratePolicy(policy: ProviderInput['policy']): RunWorkspace['policy'] {
  if (!policy) return undefined
  const raw = policy.toolNames as unknown
  const iterable = Array.isArray(raw) || raw instanceof Set ? raw : []
  return { ...policy, toolNames: new Set(iterable as Iterable<string>) }
}

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
   * Este es el único lugar que conoce la ocupación REAL del agent-host: un
   * mismo agent-host puede estar registrado en varios daemons, y el cap que
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
   * agent-host con cualquier estado sin tocar el disco.
   */
  state?: AgentHostState
  onStateChange?: (state: AgentHostState) => void | Promise<void>
  /**
   * Construye un provider por id. Inyectado (y opcional) para que los tests
   * puedan cambiar de provider sin instanciar los reales — que abren clientes
   * HTTP y tocan el disco.
   */
  createProviderById?: (id: string, workspace: AgentHostState['workspace']) => IAgentProvider
  /** Orígenes extra permitidos por CORS, además de localhost. Default:
   *  `AGENT_HOST_CORS_ORIGINS` (coma-separado). */
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
   * porque es una decisión del proceso, no de la API: un agent-host sin archivo
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

/**
 * Comparación de secretos en tiempo constante.
 *
 * Un `!==` filtra por timing cuántos caracteres del prefijo acertaste, así que
 * un atacante puede recuperar el token byte a byte en vez de tener que
 * adivinarlo entero. Es la misma función que usa apps/server
 * (routes/api-auth.ts); la diferencia es que acá faltaba.
 */
function secretEquals(provided: string | undefined, secret: string): boolean {
  if (!provided) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(secret)
  // timingSafeEqual tira si los largos difieren, así que hay que cortar antes
  // — y el largo no es lo que este guard protege.
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** Valida el `maxConcurrentRuns` de un PUT /v1/admission. Devuelve el motivo
 *  del rechazo, o `null` si es válido. */
function validateMaxConcurrentRunsUpdate(raw: unknown): string | null {
  if (raw !== null && (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0)) {
    return 'maxConcurrentRuns debe ser un número >= 0, o null'
  }
  return null
}

/** 0 se guarda como null: "sin tope", el mismo criterio que el engine. */
function normalizeMaxConcurrentRuns(raw: number | null): number | null {
  return raw === null || raw === 0 ? null : raw
}

/** Valida el `rules` de un PUT /v1/admission. Devuelve el motivo del
 *  rechazo, o `null` si es válido. */
function validateAdmissionRulesUpdate(rules: unknown): string | null {
  if (!Array.isArray(rules) || !rules.every(isAdmissionRule)) {
    return 'rules debe ser una lista de {field, op, value}'
  }
  return null
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
  extraCorsOrigins = envCorsOrigins(Bun.env.AGENT_HOST_CORS_ORIGINS),
}: CreateAppDeps): Hono {
  const app = new Hono()

  // Mutable: la pantalla puede cambiarlo sin reiniciar. Un run en vuelo se
  // queda con el que le tocó — `provider.run()` ya fue invocado y su promesa
  // sigue su curso; el cambio sólo aplica a los runs siguientes.
  let provider = initialProvider

  // Estado vivo del proceso. `maxConcurrentRuns` del deps sigue siendo el
  // valor de arranque (el env), y el estado guardado lo pisa si existe: lo
  // que el operador eligió en la pantalla gana sobre el .env.
  const state: AgentHostState = initialState ?? {
    registerServerUrls: [],
    providerId: null,
    maxConcurrentRuns: maxConcurrentRuns ?? null,
    admissionRules: [],
    workspace: {
      reposBase: null,
      worktreeBase: null,
      gitAuthorName: null,
      gitAuthorEmail: null,
      gitSigningKeyPath: null,
    },
    systemPrompt: [],
  }

  async function persist(): Promise<void> {
    await onStateChange?.(state)
  }

  /**
   * Sesiones async vivas en ESTE proceso (un tmux, una tab de iTerm).
   *
   * Existe porque `SessionHandle` trae funciones (`liveness`, `close`) que no
   * cruzan HTTP: al serializar la respuesta de /v1/run se pierden y del otro
   * lado llegan sólo sus coordenadas. El daemon las necesita igual —para el
   * watchdog de liveness y para cerrar la sesión al cancelar— así que se
   * guardan acá y se exponen como endpoints; el `RemoteAgentProvider`
   * reconstruye un handle que los llama.
   *
   * Es un CACHE, no la fuente de verdad: una sesión de tmux o una tab de
   * iTerm viven en el SO y sobreviven a que este proceso reinicie. Cuando el
   * mapa no tiene el id, `sessionFor` lo reconstruye preguntándole al SO
   * (ver abajo) — antes este miss se reportaba como "no la conozco" y el
   * daemon lo leía como muerta, abandonando runs que seguían trabajando.
   */
  const sessions = new Map<string, SessionHandle>()

  /**
   * El disco de cada run en vuelo — lo que `/v1/mcp` necesita para ejecutar
   * una tool de filesystem contra el workspace CORRECTO.
   *
   * MCP es una conexión, no una llamada: el cliente abre una sola contra
   * `/v1/mcp?run=<id>` y por ahí pasan todas las tools del run. El `?run=` es
   * lo único que identifica de qué workspace se trata, así que lo que
   * `resolveWorkspace` acaba de resolver se guarda acá bajo esa clave.
   *
   * Indexado por `runId` y no por `taskId` a propósito: un sub-agente corre
   * sobre la misma task que su padre y pisaría su entrada.
   */
  const runWorkspaces = new Map<string, RunWorkspace>()

  /**
   * `sessionId → runId` de los runs async en vuelo.
   *
   * Es lo que distingue "el run terminó" de "el run recién empezó": en un
   * provider async `provider.run()` vuelve apenas lanzó la sesión, y las
   * tools del CLI llegan a `/v1/mcp` DESPUÉS. Sin esto, el `finally` del
   * handler borraba el workspace y la primera tool del agente no encontraba
   * su repo.
   */
  const sessionRuns = new Map<string, string>()

  /** ¿Queda una sesión async apoyada en este run? Mientras la haya, su
   *  workspace tiene que seguir resolviendo en `/v1/mcp`. */
  function hasLiveSession(runId: string): boolean {
    for (const mapped of sessionRuns.values()) if (mapped === runId) return true
    return false
  }

  /** Suelta el workspace de la sesión que se está cerrando. Es la contracara
   *  del `finally` de un run sync: el mismo recurso, liberado cuando de
   *  verdad ya no hay quien lo use. */
  function releaseSessionRun(sessionId: string): void {
    const runId = sessionRuns.get(sessionId)
    if (!runId) return
    sessionRuns.delete(sessionId)
    if (!hasLiveSession(runId)) runWorkspaces.delete(runId)
  }

  /**
   * El handle de una sesión: del cache si está, reconstruido desde el SO si
   * no. `kind` viene en la query porque con el id solo no se sabe a quién
   * preguntarle; sin `kind` (un daemon viejo) sólo queda el cache.
   */
  function sessionFor(id: string, kind: string | undefined): SessionHandle | undefined {
    const cached = sessions.get(id)
    if (cached) return cached
    if (kind === 'tmux') return tmuxSessionHandle(id)
    if (kind === 'iterm') return itermSessionHandle(id)
    return undefined
  }

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
  // agent-host es el único que conoce ese estado.
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
      // `x-ia-flow-token` va en la lista o el preflight lo rechaza ANTES de
      // llegar al guard: aceptar el header en el guard no sirve de nada si el
      // browser nunca llega a mandarlo.
      c.header('access-control-allow-headers', 'authorization, content-type, x-ia-flow-token')
      c.header('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS')
      c.header('access-control-max-age', '600')
    }
    // El preflight viaja SIN Authorization por definición: contestarlo antes
    // del middleware de auth es lo que evita que muera con 401.
    if (c.req.method === 'OPTIONS') return c.body(null, 204)
    await next()
  })

  // `GET /` no sirve una pantalla: la consola es la ruta `/agent-host` de la SPA
  // de apps/web. Devolver una pista es más útil que un 404 para quien abra
  // este puerto en el browser.
  app.get('/', (c) =>
    c.json({
      service: 'agent-host',
      ui: 'la consola es /agent-host en la app de ia-flow — apuntala a esta URL',
    }),
  )

  // El guard. Todo lo de abajo lo cruza; lo de arriba (`GET /`) no, a
  // propósito — ver el comentario de esa ruta.
  //
  // Es el MISMO contrato que el de apps/server (routes/api-auth.ts), y eso
  // importa por dos motivos: la consola es la misma web para los dos, así que
  // un solo camino de código le sirve a ambos; y el operador no tiene que
  // recordar que uno acepta un header y el otro no.
  app.use('*', async (c, next) => {
    if (!token) {
      log.error({}, 'API_AI_PROVIDER_TOKEN no configurado — rechazando todo')
      return c.json({ error: 'server misconfigured: no auth token set' }, 500)
    }
    // Los dos headers, igual que el server: `x-ia-flow-token` para el fetch de
    // la web (no arrastra el `Authorization` a un preflight) y `Bearer` para
    // curl y para el server principal, que ya manda ese.
    const provided =
      // `||` y no `??`: un `x-ia-flow-token` VACÍO no es nullish, así que con
      // `??` descartaba el fallback a `Authorization` y devolvía 401 aunque el
      // Bearer fuera correcto. Un header vacío es "no mandó token", no "mandó
      // el token vacío".
      c.req.header('x-ia-flow-token') || c.req.header('authorization')?.replace(/^Bearer\s+/i, '')
    if (!secretEquals(provided, token)) return c.json({ error: 'unauthorized' }, 401)
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
      return c.json({ error: 'este agent-host no puede cambiar de provider' }, 400)

    provider = createProviderById(id, state.workspace)
    state.providerId = id
    await persist()

    // El server guardó nombre y descripción CUANDO se registró: sin volver a
    // darse de alta seguiría anunciando el provider viejo, y el operador vería
    // en la web del server algo distinto de lo que este agent-host ejecuta.
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
      const error = validateMaxConcurrentRunsUpdate(body.maxConcurrentRuns)
      if (error) return c.json({ error }, 400)
      state.maxConcurrentRuns = normalizeMaxConcurrentRuns(body.maxConcurrentRuns as number | null)
    }

    if ('rules' in body) {
      const error = validateAdmissionRulesUpdate(body.rules)
      if (error) return c.json({ error }, 400)
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

  // GET/PUT /v1/system-prompt — el system prompt propio de ESTA máquina.
  //
  // No reconstruye el provider: a diferencia de `workspace` (que el
  // WorkspaceManager toma al construirse), esto se lee en cada run dentro de
  // `runAcceptedProvider` — no hay nada que rehacer acá, sólo persistir.
  app.get('/v1/system-prompt', (c) => c.json({ blocks: state.systemPrompt }))

  app.put('/v1/system-prompt', async (c) => {
    const body = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object') return c.json({ error: 'body inválido' }, 400)

    state.systemPrompt = sanitizeSystemPrompt(body, state.systemPrompt)
    await persist()

    log.info({ blocks: state.systemPrompt.length }, 'system prompt cambiado desde la consola')
    return c.json({ blocks: state.systemPrompt })
  })

  // GET /v1/logs — el final del archivo, para la card de logs de la consola.
  //
  // El filtro corre ACÁ, sobre el archivo, y no en el navegador sobre lo ya
  // devuelto: filtrar lo que entró en la última página encontraría los
  // errores salvo justo los que uno busca, que son los viejos. Ver
  // log-tail.ts.
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

  // ── MCP: las tools que operan sobre ESTE disco ───────────────────────────
  //
  // Un run de terminal detrás de un agent-host tiene dos discos: el CLI y el
  // workspace están acá, pero la fuente de issues, GitHub, Slack, la memoria
  // y el registry de pending tasks están en el daemon. Hasta ahora TODAS sus
  // tools salían por un solo MCP apuntado al daemon, así que un `fs_write`
  // escribía en la máquina equivocada sin que nada fallara.
  //
  // Este endpoint sirve la otra mitad: sólo las tools `runsOn: 'agent-disk'`,
  // contra el workspace que `resolveWorkspace` ya preparó para ese run. El
  // CLI corre en esta misma máquina, así que lo alcanza por localhost — no
  // hace falta exponer nada nuevo ni un túnel.
  //
  // El protocolo es el mismo `handleMcpRequest` que sirve `/api/mcp` en el
  // daemon; lo único de acá es el recorte y el `ToolContext`.
  const mcpDeps: McpServerDeps = {
    serverName: 'ia-flow-local',
    serves: (t) => t.runsOn === 'agent-disk',
    // `sync` porque el sandbox que `bash_run` y `workspace_reset` piden SÍ
    // existe acá: `prepareWorkspace` materializó el worktree y resolvió los
    // `writePaths` antes de arrancar. Esas dos declaran `providerKinds:
    // ['sync']` por el daemon, que sirviendo a un CLI no construye ninguno.
    providerKind: 'sync',
    // El disco sale del `?run=`, no de la llamada. Un run que no está en el
    // mapa (terminó, o el proceso reinició) queda sin repoPaths: las tools
    // rechazan por path desconocido, que es lo correcto — mejor que operar
    // sobre el workspace de otro.
    buildContext: (conn) => {
      const ws = conn.runId ? runWorkspaces.get(conn.runId) : undefined
      if (!ws) {
        log.warn({ runId: conn.runId }, 'mcp: run sin workspace conocido — sin repoPaths')
        return { repoPaths: {} }
      }
      return {
        repoPaths: ws.repoPaths,
        writePaths: ws.writePaths,
        taskId: ws.taskId,
        // `handleMcpRequest` le pisa `toolNames` con los de la conexión y
        // conserva el resto — que es de donde `bash_run` saca su allow/deny.
        policy: ws.policy,
      }
    },
  }

  function sendMcp(c: Context, res: McpResponse) {
    if (res.body === null) return c.body(null, res.status as 202 | 204)
    return c.json(res.body, res.status as 200 | 400 | 405)
  }

  app.post('/v1/mcp', async (c) => {
    let body: JsonRpcRequest
    try {
      body = await c.req.json()
    } catch {
      return sendMcp(c, mcpParseError())
    }
    const toolsParam = c.req.query('tools')
    return sendMcp(
      c,
      await handleMcpRequest(
        body,
        {
          toolNames: toolsParam ? toolsParam.split(',').filter(Boolean) : undefined,
          runId: c.req.query('run'),
          agentId: c.req.query('agent'),
          projectId: c.req.query('project'),
          taskId: c.req.query('task'),
          closesWith: c.req.query('kind') === 'sync' ? 'sync' : undefined,
        },
        mcpDeps,
      ),
    )
  })
  // Los otros dos métodos del transporte Streamable HTTP. Sin ellos el CLI
  // da la conexión por muerta antes de llegar a `tools/list`.
  app.get('/v1/mcp', (c) => sendMcp(c, mcpNoStream()))
  app.delete('/v1/mcp', (c) => c.body(null, 204))

  // ── Sesiones async ───────────────────────────────────────────────────────
  // El daemon pregunta por ellas mientras espera el callback del agente.

  app.get('/v1/sessions/:id', async (c) => {
    const id = c.req.param('id')
    const session = sessionFor(id, c.req.query('kind'))
    // Una sesión que no podemos ni ubicar se reporta `unknown`, NO muerta.
    // Antes acá salía `{alive:false, known:false}` y el daemon lo leía como
    // muerta: un reinicio de este proceso con sesiones vivas alcanzaba para
    // que el watchdog abandonara runs que estaban trabajando. Ahora el miss
    // primero intenta reconstruir el handle desde el SO (`sessionFor`), y si
    // ni eso, dice honestamente que no sabe.
    if (!session) return c.json({ liveness: 'unknown', alive: true, known: false })
    try {
      const liveness: Liveness = await session.liveness()
      // `alive` se sigue mandando para un daemon anterior a este cambio:
      // para él, `unknown` tiene que leerse como viva, no como muerta.
      return c.json({ liveness, alive: liveness !== 'dead', known: true })
    } catch (err) {
      log.warn({ err: String(err), id: session.id }, 'liveness falló — unknown')
      return c.json({ liveness: 'unknown', alive: true, known: true })
    }
  })

  app.delete('/v1/sessions/:id', async (c) => {
    const id = c.req.param('id')
    // Mismo cache-miss que arriba: tras un reinicio del agent-host la sesión
    // sigue viva en el SO y hay que poder cerrarla igual.
    const session = sessionFor(id, c.req.query('kind'))
    if (session) {
      // `close()` es idempotente por contrato (ver SessionHandle): el watchdog
      // y el cancel manual pueden llegar los dos.
      await session.close().catch((err) => {
        log.warn({ err: String(err), id }, 'close falló')
      })
      sessions.delete(id)
    }
    // Se suelta aunque el handle no estuviera cacheado: la sesión se está
    // cerrando igual, y dejar el workspace colgado lo haría crecer para
    // siempre. Fuera del `if` a propósito.
    releaseSessionRun(id)
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
   * un agent-host sin filesystem de proyecto, que es lo único que había antes).
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

  /**
   * Antepone el system prompt propio de ESTA máquina a los bloques que ya
   * trae el run (los que armó el agente del lado del daemon). Se resuelve
   * ACÁ, contra `state.systemPrompt` — nunca del lado del daemon — porque es
   * precisamente lo que el daemon que despacha no tiene por qué saber: cómo
   * correr en este gateway puntual.
   */
  function withGatewaySystemPrompt(input: ProviderInput): ProviderInput {
    if (!state.systemPrompt.length) return input
    return {
      ...input,
      systemPromptBlocks: [...(input.systemPromptBlocks ?? []), ...state.systemPrompt],
    }
  }

  /** Lee y valida el body de POST /v1/run. No lanza — un JSON inválido o que
   *  no tiene forma de `ProviderInput` es un 400, no una excepción. */
  async function readRunBody(
    c: Context,
  ): Promise<{ ok: true; body: ProviderInput } | { ok: false; error: string }> {
    let raw: unknown
    try {
      raw = await c.req.json()
    } catch {
      return { ok: false, error: 'invalid JSON body' }
    }
    if (!isProviderInput(raw)) {
      return { ok: false, error: 'body must be a ProviderInput (needs at least taskId, prompt)' }
    }
    return { ok: true, body: raw }
  }

  /**
   * Publica el disco de este run para `/v1/mcp`, ANTES de arrancar: un
   * provider de terminal lanza la sesión y el CLI puede pedir una tool en el
   * primer segundo.
   */
  function publishRunWorkspace(resolved: ProviderInput): void {
    if (!resolved.runId) return
    runWorkspaces.set(resolved.runId, {
      repoPaths: resolved.repoPaths ?? {},
      writePaths: resolved.writePaths,
      taskId: resolved.taskId,
      policy: rehydratePolicy(resolved.policy),
    })
  }

  /**
   * Se queda con la sesión que devolvió un provider async — `provider.run()`
   * vuelve apenas la lanzó y el resultado real llega después, por el callback
   * del agente al daemon; lo único que viaja en la respuesta son sus
   * coordenadas.
   *
   * Atarla al run es lo que mantiene vivo su workspace: las tools de disco
   * del CLI llegan a `/v1/mcp` DESPUÉS de que el handler devolvió.
   */
  function adoptSession(session: SessionHandle | undefined, runId: string | undefined): void {
    if (!session) return
    sessions.set(session.id, session)
    if (runId) sessionRuns.set(session.id, runId)
  }

  /** Corre el provider para un run ya admitido: cuenta el slot, redirige los
   *  logs al daemon que despachó, y libera todo en el `finally` pase lo que
   *  pase. */
  async function runAcceptedProvider(c: Context, body: ProviderInput): Promise<Response> {
    running++
    // El destino del redrive de logs es propiedad del RUN: este agent-host puede
    // estar registrado contra varios daemons y las líneas tienen que volver al
    // que despachó ESTE run. Se registra antes de arrancar —el provider empieza
    // a loguear apenas entra— y se limpia en el `finally`, pase lo que pase.
    const redriveRunId = body.runId
    const redriveUrl = daemonUrlFor(body)
    if (redriveRunId && redriveUrl) setRunLogTarget(redriveRunId, redriveUrl)
    try {
      const resolved = await resolveWorkspace(body)
      publishRunWorkspace(resolved)
      const output = await provider.run({
        ...withGatewaySystemPrompt(resolved),
        daemonUrl: daemonUrlFor(body),
        // El abort del request es el corte real de un run remoto: por ahí
        // llegan el cancel del operador y el timeout del daemon
        // (`IA_FLOW_REMOTE_RUN_TIMEOUT_MS`, 30' por default). Sin esto el
        // daemon soltaba el fetch y el proceso de acá seguía vivo, reteniendo
        // su slot para siempre — y era lo único que el timeout hardcodeado de
        // `claude-print` tapaba a medias.
        signal: c.req.raw.signal,
      })
      adoptSession(output.session, resolved.runId)
      return c.json(output)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error({ err: message, taskId: body.taskId }, 'provider run failed')
      return c.json({ error: message }, 500)
    } finally {
      running--
      // Sin esto el mapa crece con cada run y, peor, un `runId` reciclado
      // mandaría líneas al daemon equivocado.
      if (redriveRunId) clearRunLogTarget(redriveRunId)
      // El workspace de un run SYNC ya no le sirve a nadie: su loop de tools
      // corrió adentro de `provider.run()` y terminó. El de uno async sigue
      // vivo —la sesión recién arranca y sus tools llegan después— y lo
      // libera `releaseSessionRun` cuando esa sesión se cierra.
      if (redriveRunId && !hasLiveSession(redriveRunId)) runWorkspaces.delete(redriveRunId)
    }
  }

  app.post('/v1/run', async (c) => {
    const parsed = await readRunBody(c)
    if (!parsed.ok) return c.json({ error: parsed.error }, 400)
    const { body } = parsed

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
        { error: reason ?? 'agent-host at capacity', running, maxConcurrentRuns: capOf() },
        503,
      )
    }

    return runAcceptedProvider(c, body)
  })

  return app
}
