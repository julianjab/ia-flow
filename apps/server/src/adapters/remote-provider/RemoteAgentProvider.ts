// Proxy hacia un provider expuesto por una instancia de
// apps/agent-host registrada vía /api/provider-registrations.
// Implementa IAgentProvider igual que anthropic-api/tmux-claude/iterm-claude
// — el resto del engine (Agent.run, resolveProvider) no distingue un
// provider local de uno remoto.
//
// `id` se namespacea como `remote:<registrationId>` en vez de usar el
// `remoteProviderId` crudo (ej. "claude-print") para que registrar el mismo
// providerId dos veces (dos agent-hosts distintos, o el mismo agent-host con dos
// tokens) no colisione en el ProviderRegistry — cada registración es un
// provider elegible propio.
import type {
  Admission,
  AdmissionRequest,
  IAgentProvider,
  Liveness,
  ProviderInput,
  ProviderKind,
  ProviderOutput,
  SessionHandle,
} from '@ia-flow/ai-providers'
import { ADMIT, decline, ProviderAtCapacityError, withinDeclaredCap } from '@ia-flow/ai-providers'
import type { WorkspacePlan } from '@ia-flow/shared'
import { EMPTY_WORKSPACE_PLAN } from '@ia-flow/shared'
import type { ProviderRegistration } from '../../domain/ports/IProviderRegistrationRepository.js'
import { createLogger } from '../../logger.js'
import { daemonPublicUrl } from '../../server-port.js'

// La sonda corre en el camino caliente del dispatch (una por candidato):
// cortita a propósito, un agent-host que tarda más que esto en decir si puede
// se trata como disponible y que decida el run.
const CAPACITY_PROBE_TIMEOUT_MS = 2_000

const log = createLogger('remote-provider')

// Cuánto espera el POST /v1/run antes de rendirse. Explícito a propósito:
// Bun >= 1.2 le pone 300s por default a `fetch`, y ese default cortaba runs
// remotos largos con un `TimeoutError: The operation timed out.` que llegaba
// al agente como si el run hubiera fallado (onError → issue a blocked). El
// engine tiene que ser el que elige cuánto esperar, no el runtime. `0`
// desactiva el límite.
// `Number()` y no `parseInt`: `parseInt('30s') === 30` aceptaría un typo en
// silencio, `Number('30s')` es NaN y cae al default. Sólo `0` explícito
// desactiva el límite.
/** Cuánto se espera que el agent-host ACEPTE el run (no que lo termine). */
const ACCEPT_TIMEOUT_MS = 30_000

/** Timeout de UNA sonda. Corto a propósito: la que falla se reintenta. */
const POLL_TIMEOUT_MS = 10_000

/**
 * Cada cuánto se le pregunta por el resultado. Un run dura minutos u horas:
 * bajarlo sólo suma requests, subirlo sólo suma latencia al cierre.
 *
 * Lazy, como el resto de los env del repo: los valores guardados en la DB
 * llegan a `process.env` por `envRepo.loadIntoProcess()`, que corre DESPUÉS
 * de los imports. Una constante de módulo los ignoraría en silencio.
 */
function pollIntervalMs(): number {
  const parsed = Number(Bun.env.IA_FLOW_REMOTE_POLL_INTERVAL_MS?.trim())
  return Number.isFinite(parsed) && parsed >= 50 ? parsed : 2_000
}

/**
 * Cuánto silencio seguido del agent-host se tolera antes de dar el run por
 * perdido. Se mide en TIEMPO y no en cantidad de sondas: así no depende del
 * interval, que es lo que en realidad importa — dos minutos alcanzan para un
 * restart del agent-host o un blip de red, y no tanto como para colgar un slot.
 */
function maxSilenceMs(): number {
  const parsed = Number(Bun.env.IA_FLOW_REMOTE_MAX_SILENCE_MS?.trim())
  // `0` = sin límite, la convención del repo (ver los caps del engine). Con
  // `>= 0` a secas, un operador que lo ponía en 0 creyendo que desactivaba el
  // corte obtenía el comportamiento MÁS agresivo: la primera sonda fallida
  // mataba el run.
  if (parsed === 0) return Number.POSITIVE_INFINITY
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120_000
}

/** Lo que devuelve `GET /v1/runs/:id`. */
interface DetachedRunStatus {
  status: 'running' | 'done' | 'failed' | 'unknown'
  output?: ProviderOutput
  error?: string
}

const RUN_TIMEOUT_MS = (() => {
  const raw = Bun.env.IA_FLOW_REMOTE_RUN_TIMEOUT_MS?.trim()
  const parsed = raw ? Number(raw) : Number.NaN
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1_800_000
})()

/** `Retry-After` en segundos (RFC 9110) → ms. Ignora la forma con fecha:
 *  hoy nadie la emite y no vale complicar el parseo por eso. */
function retryAfterMsFrom(res: Response): number | undefined {
  const raw = res.headers.get('retry-after')
  const secs = raw ? Number.parseInt(raw, 10) : Number.NaN
  return Number.isFinite(secs) && secs >= 0 ? secs * 1_000 : undefined
}

export function remoteProviderId(registrationId: string): string {
  return `remote:${registrationId}`
}

/** Las pistas de la tarea viajan en la query para que las admissionRules del
 *  agent-host se evalúen ACÁ, en la sonda — ver el docstring de `canAccept`. */
function buildCapacityProbeUrl(baseUrl: string, req: AdmissionRequest): URL {
  const probe = new URL(`${baseUrl}/v1/capacity`)
  for (const repo of req.task?.repos ?? []) probe.searchParams.append('repo', repo)
  // `assignees: []` (conocido y vacío — los sources de GitHub siempre lo
  // setean) viaja como un marcador `assignee=` vacío: así el agent-host puede
  // distinguir "sin asignar" de "no sé quién está asignado" (daemon viejo,
  // sin pistas) y una regla `assignee equals X` rechaza el issue sin
  // asignar en vez de dejarlo pasar.
  const assignees = req.task?.assignees
  if (assignees && assignees.length === 0) probe.searchParams.append('assignee', '')
  for (const login of assignees ?? []) probe.searchParams.append('assignee', login)
  if (req.agentId) probe.searchParams.set('agentId', req.agentId)
  if (req.task?.projectId) probe.searchParams.set('projectId', req.task.projectId)
  if (req.task?.type) probe.searchParams.set('taskType', req.task.type)
  return probe
}

async function parseCapacityResponse(res: Response): Promise<Admission> {
  if (!res.ok) return ADMIT
  const body = (await res.json()) as {
    accepting?: unknown
    reason?: unknown
    retryAfterMs?: unknown
  }
  if (body.accepting !== false) return ADMIT
  return decline(
    typeof body.reason === 'string' && body.reason
      ? `agent-host: ${body.reason}`
      : 'el agent-host no está aceptando trabajo',
    typeof body.retryAfterMs === 'number' ? body.retryAfterMs : undefined,
  )
}

export class RemoteAgentProvider implements IAgentProvider {
  readonly id: string
  readonly kind: ProviderKind
  readonly name: string
  readonly description: string

  constructor(private registration: ProviderRegistration) {
    this.id = remoteProviderId(registration.id)
    this.kind = registration.remoteKind
    this.name = `${registration.remoteName} (${registration.name})`
    this.description = registration.remoteDescription
  }

  /**
   * Le pregunta al agent-host. Es el caso que justifica que la decisión sea del
   * provider y no del engine: el agent-host corre en otro proceso, puede estar
   * registrado en varios daemons, y sabe cosas que este daemon no —
   * su RAM, si está ocupado con trabajo que no vino de acá.
   *
   * Primero el cap declarado (gratis, no sale del proceso) y recién después
   * la sonda de red. Fail-open en todo lo que no sea un "no" explícito: un
   * agent-host viejo sin el endpoint (404), un timeout o un DNS caído admiten y
   * el run sigue el camino normal — donde un fallo real sí se reporta.
   */
  async canAccept(req: AdmissionRequest): Promise<Admission> {
    const declared = withinDeclaredCap(req)
    if (!declared.accept) return declared

    const { baseUrl, token } = this.registration
    const startedAt = Date.now()
    // Un rechazo acá hace que `resolveProvider` pruebe el siguiente candidato
    // del agente. Sin pistas, una regla sobre la tarea recién corta en el
    // POST /v1/run (503), y un 503 difiere el issue en vez de pasar al
    // siguiente provider — para una regla estática (assignee, repo) eso es
    // diferir para siempre.
    const probe = buildCapacityProbeUrl(baseUrl, req)
    log.debug(
      {
        providerId: this.id,
        taskId: req.task?.id,
        agentId: req.agentId,
        url: probe.toString(),
      },
      'remote: sondeando capacidad del agent-host',
    )
    try {
      const res = await fetch(probe.toString(), {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(CAPACITY_PROBE_TIMEOUT_MS),
      })
      log.debug(
        { providerId: this.id, status: res.status, elapsedMs: Date.now() - startedAt },
        'remote: sonda de capacidad respondió',
      )
      return await parseCapacityResponse(res)
    } catch (err) {
      // Fail-open, pero que se vea: sin este log un agent-host inalcanzable en la
      // sonda es indistinguible de uno que admitió.
      log.debug(
        {
          providerId: this.id,
          elapsedMs: Date.now() - startedAt,
          err: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        },
        'remote: sonda de capacidad falló — admitiendo igual (fail-open)',
      )
      return ADMIT
    }
  }

  /**
   * No hay nada que preparar de este lado del cable: el terreno lo arma el
   * agent-host, que es quien tiene el disco donde va a correr el agente. El
   * `WorkspaceRequest` viaja dentro del `ProviderInput` y allá se resuelve
   * (ver `resolveWorkspace` en apps/agent-host/src/app.ts).
   *
   * Se implementa explícitamente —en vez de omitirlo— porque es justamente
   * el caso que motivó mover el workspace a los providers: antes el engine
   * calculaba paths de ESTA máquina y se los mandaba a la otra.
   */
  async prepareWorkspace(): Promise<WorkspacePlan> {
    return EMPTY_WORKSPACE_PLAN
  }

  async run(input: ProviderInput): Promise<ProviderOutput> {
    const { baseUrl, token } = this.registration
    // `input.policy.toolNames` is a Set (PolicyLike, packages/ai-providers/
    // src/contract.ts) — JSON.stringify silently drops a Set's contents
    // (it serializes to `{}`, not an array), so without this the remote
    // agent-host receives an empty allow-list and its own `new Set({})`/spread
    // over that empty object throws ("Spread syntax requires
    // ...iterable[Symbol.iterator] to be a function"). Rebuild the body as
    // a plain array here so the agent-host (packages/ai-providers/src/
    // anthropic-api/provider.ts) gets the real tool names back.
    const withDaemon = this.withDaemonFields(input)
    const body = withDaemon.policy
      ? {
          ...withDaemon,
          policy: { ...withDaemon.policy, toolNames: [...withDaemon.policy.toolNames] },
        }
      : withDaemon
    const payload = JSON.stringify(body)
    const startedAt = Date.now()
    const elapsed = () => Date.now() - startedAt
    log.debug(
      {
        providerId: this.id,
        taskId: input.taskId,
        url: `${baseUrl}/v1/run`,
        bytes: payload.length,
        timeoutMs: RUN_TIMEOUT_MS || null,
        daemonUrl: withDaemon.daemonUrl,
        tools: withDaemon.policy ? [...withDaemon.policy.toolNames].length : 0,
      },
      'remote: POST /v1/run — enviando el run al agent-host',
    )

    let res: Response
    try {
      res = await fetch(`${baseUrl}/v1/run?wait=poll`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: payload,
        // Este request ya NO dura lo que dura el run: el agent-host acepta y
        // contesta 202 (ver `?wait=poll`), así que alcanza con el timeout de
        // aceptación. El presupuesto del run entero lo lleva el sondeo.
        //
        // `timeout: false` desarma el default de 300s del runtime — la opción
        // de fetch en Bun es booleana, un número no configura milisegundos.
        signal: input.signal
          ? AbortSignal.any([input.signal, AbortSignal.timeout(ACCEPT_TIMEOUT_MS)])
          : AbortSignal.timeout(ACCEPT_TIMEOUT_MS),
        timeout: false,
      } as RequestInit)
    } catch (err) {
      // El punto ciego que costó diagnosticar: acá moría el run sin dejar
      // rastro de cuánto había esperado ni contra qué agent-host.
      log.debug(
        {
          providerId: this.id,
          taskId: input.taskId,
          url: `${baseUrl}/v1/run`,
          elapsedMs: elapsed(),
          timeoutMs: RUN_TIMEOUT_MS || null,
          aborted: input.signal?.aborted ?? false,
          err: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        },
        'remote: POST /v1/run falló antes de recibir respuesta',
      )
      throw err
    }

    log.debug(
      { providerId: this.id, taskId: input.taskId, status: res.status, elapsedMs: elapsed() },
      'remote: /v1/run respondió',
    )

    if (!res.ok) await this.throwForFailedRun(res, baseUrl)

    // Una sola lectura: el body de un Response se consume, y ramificar con
    // dos `res.json()` hacía que un 202 sin `runId` (un proxy, un agent-host
    // futuro) muriera con "Body already used" en vez de decir qué pasó.
    const parsed = (await res.json()) as { runId?: string } & ProviderOutput
    // Un agent-host anterior a `?wait=poll` ignora el flag y contesta 200 con
    // el output colgado del request. Se acepta tal cual: un daemon nuevo
    // tiene que seguir hablándole a un agent-host viejo.
    const output = await this.collectOutput(parsed, res.status, baseUrl, token, input)
    log.debug(
      {
        providerId: this.id,
        taskId: input.taskId,
        elapsedMs: elapsed(),
        stopReason: output.stopReason ?? null,
        sessionKind: output.session?.kind ?? null,
      },
      'remote: run completado',
    )
    // `session` llegó como coordenadas: sus funciones se perdieron al
    // serializar. Se rehidrata contra los endpoints del agent-host para que el
    // watchdog y el cancel del orquestador funcionen igual que en local.
    return output.session ? { ...output, session: this.remoteSession(output.session) } : output
  }

  /** Los campos que sólo este daemon puede completar antes de mandar el
   *  input al agent-host — ver los comentarios de cada campo más abajo. */
  private withDaemonFields(input: ProviderInput): ProviderInput {
    return {
      ...input,
      // El default de los providers de terminal es `localhost`, que allá
      // apunta al agent-host (y su PORT es el suyo, no el nuestro). Se manda la
      // URL por la que ESTA máquina es alcanzable desde afuera; sin esto un
      // run async remoto arranca sin tools y sin poder reportar el final.
      daemonUrl: input.daemonUrl ?? daemonPublicUrl(),
      // Y con qué autenticarse contra ella: el `IA_FLOW_API_TOKEN` de allá es
      // el del agent-host, no el nuestro, así que sin esto un run async remoto
      // vuelve a arrancar sin tools apenas este daemon tiene el guard puesto.
      //
      // Va cuando el otro lado va a ABRIR una conexión contra `/api/mcp`, que
      // es exactamente cuando el agente declara tools y el provider de allá
      // las entrega por MCP. Sin el token, con el guard del daemon puesto,
      // cada tool del agente contesta 401 y el run arranca sin ninguna.
      //
      // No alcanza con mirar el kind. Era `kind === 'async'` con el argumento
      // de que un remoto sync ejecuta sus tools allá y nunca le habla a
      // `/api/mcp` — cierto para `anthropic-api`, falso para `claude-print`,
      // que es sync y las entrega por MCP igual que un CLI de terminal (no
      // acepta definiciones inyectadas).
      //
      // El precio de mandarlo de más es real y acotado: este token abre
      // `PUT /api/env-vars` y `POST /api/tasks` de ESTE daemon, y del otro
      // lado aterriza en el settings.json per-run y en el env del CLI, cuyo
      // Bash nativo no pasa por el deny-list de `bash_run`. Por eso se
      // condiciona a `tools[]` y no se manda siempre: un agente sin tools no
      // tiene por qué recibirlo.
      ...(input.tools?.length
        ? { daemonToken: input.daemonToken || Bun.env.IA_FLOW_API_TOKEN?.trim() || undefined }
        : {}),
    }
  }

  /**
   * De la respuesta de `/v1/run` al `ProviderOutput`, por los dos caminos.
   *
   * Un agent-host anterior a `?wait=poll` ignora el flag y contesta 200 con
   * el output colgado del request: se acepta tal cual, un daemon nuevo tiene
   * que seguir hablándole a uno viejo. El 202 con `runId` enciende el sondeo.
   */
  private async collectOutput(
    parsed: { runId?: string } & ProviderOutput,
    status: number,
    baseUrl: string,
    token: string,
    input: ProviderInput,
  ): Promise<ProviderOutput> {
    if (parsed.runId) return this.awaitDetachedRun(baseUrl, token, parsed.runId, input)
    if (status === 202) {
      // Un 202 es "lo acepté, vení a buscarlo", y sin `runId` no hay dónde.
      // Devolver este body casteado a ProviderOutput haría que el engine lo
      // cerrara como terminado —sin stopReason ni contenido— aplicando
      // `onFinish` sobre un run que recién arrancaba.
      throw new Error(
        `RemoteAgentProvider(${this.id}): ${baseUrl} aceptó el run con 202 pero no mandó runId`,
      )
    }
    return parsed as ProviderOutput
  }

  /**
   * Espera un run que el agent-host aceptó y corre desacoplado, preguntándole
   * por el resultado.
   *
   * **Por qué sondear y no recibir un callback.** El resultado vive del lado
   * del agent-host hasta que lo vengan a buscar: así este daemon no necesita
   * exponerle una ruta nueva ni el agent-host aprender a autenticarse contra
   * su API, y un daemon que se reinició a mitad del run puede volver a
   * preguntar en vez de haberse perdido el único aviso.
   *
   * El costo es un request cada `POLL_INTERVAL_MS` — despreciable contra un
   * run que dura minutos u horas, y cada uno con su propio timeout corto, así
   * que un blip de red ya no es un run fallido: se reintenta en el siguiente.
   * Eso es lo que el request colgado no podía hacer.
   */
  private async awaitDetachedRun(
    baseUrl: string,
    token: string,
    runId: string,
    input: ProviderInput,
  ): Promise<ProviderOutput> {
    const auth = { authorization: `Bearer ${token}` }
    const deadline = RUN_TIMEOUT_MS > 0 ? Date.now() + RUN_TIMEOUT_MS : Number.POSITIVE_INFINITY
    // Desde cuándo no contesta. Se limpia con cada respuesta buena: lo que
    // importa es el silencio SEGUIDO, no el total de un run de una hora.
    let silentSince: number | undefined

    while (true) {
      await this.assertStillWaiting(baseUrl, auth, runId, input, deadline)
      await Bun.sleep(pollIntervalMs())

      const probe = await this.probeDetachedRun(baseUrl, auth, runId)
      if (!probe.ok) {
        silentSince ??= Date.now()
        // Se insiste mientras el agent-host pueda volver: un corte de red no
        // es un run fallido. Recién cuando no contesta de forma sostenida se
        // da por perdido — y ahí el run SÍ falló, porque el proceso que lo
        // corría no está.
        if (Date.now() - silentSince >= maxSilenceMs()) {
          // Se avisa igual que en los otros dos cortes, aunque sea probable
          // que tampoco llegue: si el agent-host vuelve en sí, el DELETE es
          // lo único que libera el slot que este run dejó tomado.
          await this.cancelDetachedRun(baseUrl, auth, runId)
          throw new Error(
            `RemoteAgentProvider(${this.id}): el agent-host dejó de responder durante el run ${runId} — ${probe.error}`,
          )
        }
        continue
      }

      silentSince = undefined
      if (probe.status.status === 'running') continue
      return this.outputOf(probe.status, runId)
    }
  }

  /** Traduce un estado terminal a su output, o al error que lo explica. Cada
   *  caso con su mensaje: los diagnósticos son distintos y mandarlos al mismo
   *  texto apunta al lugar equivocado. */
  private outputOf(status: DetachedRunStatus, runId: string): ProviderOutput {
    if (status.status === 'done') {
      if (status.output) return status.output
      throw new Error(
        `RemoteAgentProvider(${this.id}): el run ${runId} terminó sin output — el agent-host lo reportó vacío`,
      )
    }
    if (status.status === 'failed') {
      throw new Error(`RemoteAgentProvider(${this.id}): ${status.error ?? 'el run falló'}`)
    }
    // `unknown`: el agent-host no conoce este run. Reinició y el run murió
    // con él, o venció su ventana de gracia. En los dos casos no hay nada más
    // que esperar, y decirlo es mejor que sondear para siempre.
    throw new Error(
      `RemoteAgentProvider(${this.id}): el agent-host perdió el run ${runId} (¿reinició?)`,
    )
  }

  /** Los dos motivos para dejar de esperar que no vienen del agent-host: el
   *  cancel del operador y el presupuesto del run. Los dos avisan del otro
   *  lado antes de tirar — si no, el CLI sigue trabajando sobre una task que
   *  este daemon ya dio por cerrada. */
  private async assertStillWaiting(
    baseUrl: string,
    auth: Record<string, string>,
    runId: string,
    input: ProviderInput,
    deadline: number,
  ): Promise<void> {
    if (input.signal?.aborted) {
      await this.cancelDetachedRun(baseUrl, auth, runId)
      throw new Error(`RemoteAgentProvider(${this.id}): run cancelado`)
    }
    if (Date.now() > deadline) {
      await this.cancelDetachedRun(baseUrl, auth, runId)
      throw new Error(
        `RemoteAgentProvider(${this.id}): el run ${runId} superó IA_FLOW_REMOTE_RUN_TIMEOUT_MS (${RUN_TIMEOUT_MS}ms)`,
      )
    }
  }

  /** Una sonda. No tira: un fallo de red es un dato para el llamador, que es
   *  quien decide si ya es suficiente silencio. */
  private async probeDetachedRun(
    baseUrl: string,
    auth: Record<string, string>,
    runId: string,
  ): Promise<{ ok: true; status: DetachedRunStatus } | { ok: false; error: string }> {
    try {
      const res = await fetch(`${baseUrl}/v1/runs/${encodeURIComponent(runId)}`, {
        headers: auth,
        signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
      })
      if (!res.ok) throw new Error(`status ${res.status}`)
      return { ok: true, status: (await res.json()) as DetachedRunStatus }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      log.debug({ providerId: this.id, runId, err: error }, 'remote: el sondeo del run falló')
      return { ok: false, error }
    }
  }

  /** Le avisa al agent-host que deje de trabajar. Best-effort: si no llega,
   *  lo que sigue es que el run se dé por terminado de este lado igual. */
  private async cancelDetachedRun(
    baseUrl: string,
    auth: Record<string, string>,
    runId: string,
  ): Promise<void> {
    await fetch(`${baseUrl}/v1/runs/${encodeURIComponent(runId)}`, {
      method: 'DELETE',
      headers: auth,
      signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
    }).catch((err) => {
      log.warn(
        { providerId: this.id, runId, err: String(err) },
        'remote: no se pudo avisar el cancel — el agent-host puede seguir trabajando',
      )
    })
  }

  /** Interpreta un `/v1/run` que no respondió 2xx y tira. Nunca retorna. */
  private async throwForFailedRun(res: Response, baseUrl: string): Promise<never> {
    const body = await res.text().catch(() => '')
    // 503 = el agent-host está al tope. Es la contracara de `canAccept`: la
    // sonda admitió y otro dispatch se comió el último slot en la ventana
    // entre sonda y run (es consultiva, no reserva). Tratarlo como error
    // dispararía el `onError` del agente — mover el issue de status y
    // comentar un fallo que no pasó. Se difiere en su lugar.
    if (res.status === 503) {
      throw new ProviderAtCapacityError(
        `RemoteAgentProvider(${this.id}): el agent-host está al tope — ${body.slice(0, 200)}`,
        retryAfterMsFrom(res),
      )
    }
    throw new Error(
      `RemoteAgentProvider(${this.id}): ${baseUrl} respondió ${res.status} — ${body.slice(0, 500)}`,
    )
  }

  /** Un `SessionHandle` que vive del otro lado del cable. */
  private remoteSession(coords: { kind: SessionHandle['kind']; id: string }): SessionHandle {
    const { baseUrl, token } = this.registration
    const auth = { authorization: `Bearer ${token}` }
    const url = `${baseUrl}/v1/sessions/${encodeURIComponent(coords.id)}`
    // El `kind` viaja en la query para que el agent-host pueda rehidratar la
    // sesión desde el SO cuando no la tiene en memoria (reinició): con el id
    // solo no sabría si preguntarle a tmux o a iTerm.
    const probeUrl = `${url}?kind=${encodeURIComponent(coords.kind)}`

    return {
      kind: coords.kind,
      id: coords.id,
      // Nada de colapsar tres estados en dos. `dead` sólo cuando el agent-host
      // dice que SÍ conoce la sesión y no está; todo lo demás —no contesta,
      // contesta mal, o contesta "no la conozco"— es `unknown`, y qué hacer
      // con eso lo decide el watchdog. `known: false` pasa de verdad cuando
      // el agent-host reinicia con la sesión corriendo, y leerlo como muerta
      // abandonaba runs vivos.
      liveness: async () => {
        try {
          const res = await fetch(probeUrl, { headers: auth, signal: AbortSignal.timeout(5000) })
          if (!res.ok) {
            log.debug(
              { providerId: this.id, sessionId: coords.id, status: res.status },
              'remote: liveness no pudo preguntar — unknown',
            )
            return 'unknown'
          }
          const body = (await res.json()) as {
            liveness?: unknown
            alive?: boolean
            known?: boolean
          }
          const state = readLiveness(body)
          log.debug({ providerId: this.id, sessionId: coords.id, state }, 'remote: liveness')
          return state
        } catch (err) {
          log.debug(
            {
              providerId: this.id,
              sessionId: coords.id,
              err: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
            },
            'remote: liveness falló — unknown',
          )
          return 'unknown'
        }
      },
      close: async () => {
        log.debug({ providerId: this.id, sessionId: coords.id }, 'remote: cerrando sesión')
        // Mismo `?kind=` que la sonda: si el agent-host reinició, necesita saber
        // a quién preguntarle para poder cerrar una sesión que sigue viva.
        await fetch(probeUrl, { method: 'DELETE', headers: auth }).catch((err) => {
          log.debug(
            {
              providerId: this.id,
              sessionId: coords.id,
              err: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
            },
            'remote: cerrar sesión falló',
          )
        })
      },
    }
  }
}

/**
 * Lee la respuesta de `GET /v1/sessions/:id` tolerando un agent-host viejo.
 *
 * El nuevo manda `liveness` explícito. Uno anterior a este cambio manda
 * `{ alive, known }`, y ahí `known: false` significa "reinicié y no la tengo"
 * — que es `unknown`, no `dead`. Sin este mapeo, actualizar el server sin
 * actualizar el agent-host reproduce el incidente original.
 */
export function readLiveness(body: {
  liveness?: unknown
  alive?: boolean
  known?: boolean
}): Liveness {
  if (body.liveness === 'alive' || body.liveness === 'dead' || body.liveness === 'unknown') {
    return body.liveness
  }
  if (body.known === false) return 'unknown'
  return body.alive === false ? 'dead' : 'alive'
}
