// Proxy hacia un provider expuesto por una instancia de
// apps/ai-provider-gateway registrada vía /api/provider-registrations.
// Implementa IAgentProvider igual que anthropic-api/tmux-claude/iterm-claude
// — el resto del engine (Agent.run, resolveProvider) no distingue un
// provider local de uno remoto.
//
// `id` se namespacea como `remote:<registrationId>` en vez de usar el
// `remoteProviderId` crudo (ej. "claude-print") para que registrar el mismo
// providerId dos veces (dos gateways distintos, o el mismo gateway con dos
// tokens) no colisione en el ProviderRegistry — cada registración es un
// provider elegible propio.
import type {
  Admission,
  AdmissionRequest,
  IAgentProvider,
  ProviderInput,
  ProviderKind,
  ProviderOutput,
  SessionHandle,
} from '@ia-flow/ai-providers'
import { ADMIT, ProviderAtCapacityError, decline, withinDeclaredCap } from '@ia-flow/ai-providers'
import { EMPTY_WORKSPACE_PLAN } from '@ia-flow/shared'
import type { WorkspacePlan } from '@ia-flow/shared'
import type { ProviderRegistration } from '../../domain/ports/IProviderRegistrationRepository.js'
import { createLogger } from '../../logger.js'
import { daemonPublicUrl } from '../../server-port.js'

// La sonda corre en el camino caliente del dispatch (una por candidato):
// cortita a propósito, un gateway que tarda más que esto en decir si puede
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
   * Le pregunta al gateway. Es el caso que justifica que la decisión sea del
   * provider y no del engine: el gateway corre en otro proceso, puede estar
   * registrado en varios daemons, y sabe cosas que este daemon no —
   * su RAM, si está ocupado con trabajo que no vino de acá.
   *
   * Primero el cap declarado (gratis, no sale del proceso) y recién después
   * la sonda de red. Fail-open en todo lo que no sea un "no" explícito: un
   * gateway viejo sin el endpoint (404), un timeout o un DNS caído admiten y
   * el run sigue el camino normal — donde un fallo real sí se reporta.
   */
  async canAccept(req: AdmissionRequest): Promise<Admission> {
    const declared = withinDeclaredCap(req)
    if (!declared.accept) return declared

    const { baseUrl, token } = this.registration
    const startedAt = Date.now()
    // Las pistas de la tarea viajan en la query para que las admissionRules
    // del gateway se evalúen ACÁ, en la sonda — un rechazo acá hace que
    // `resolveProvider` pruebe el siguiente candidato del agente. Sin pistas,
    // una regla sobre la tarea recién corta en el POST /v1/run (503), y un
    // 503 difiere el issue en vez de pasar al siguiente provider — para una
    // regla estática (assignee, repo) eso es diferir para siempre.
    const probe = new URL(`${baseUrl}/v1/capacity`)
    for (const repo of req.task?.repos ?? []) probe.searchParams.append('repo', repo)
    // `assignees: []` (conocido y vacío — los sources de GitHub siempre lo
    // setean) viaja como un marcador `assignee=` vacío: así el gateway puede
    // distinguir "sin asignar" de "no sé quién está asignado" (daemon viejo,
    // sin pistas) y una regla `assignee equals X` rechaza el issue sin
    // asignar en vez de dejarlo pasar.
    const assignees = req.task?.assignees
    if (assignees && assignees.length === 0) probe.searchParams.append('assignee', '')
    for (const login of assignees ?? []) probe.searchParams.append('assignee', login)
    if (req.agentId) probe.searchParams.set('agentId', req.agentId)
    if (req.task?.projectId) probe.searchParams.set('projectId', req.task.projectId)
    if (req.task?.type) probe.searchParams.set('taskType', req.task.type)
    log.debug(
      {
        providerId: this.id,
        taskId: req.task?.id,
        agentId: req.agentId,
        url: probe.toString(),
      },
      'remote: sondeando capacidad del gateway',
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
      if (!res.ok) return ADMIT
      const body = (await res.json()) as {
        accepting?: unknown
        reason?: unknown
        retryAfterMs?: unknown
      }
      if (body.accepting !== false) return ADMIT
      return decline(
        typeof body.reason === 'string' && body.reason
          ? `gateway: ${body.reason}`
          : 'el gateway no está aceptando trabajo',
        typeof body.retryAfterMs === 'number' ? body.retryAfterMs : undefined,
      )
    } catch (err) {
      // Fail-open, pero que se vea: sin este log un gateway inalcanzable en la
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
   * gateway, que es quien tiene el disco donde va a correr el agente. El
   * `WorkspaceRequest` viaja dentro del `ProviderInput` y allá se resuelve
   * (ver `resolveWorkspace` en apps/ai-provider-gateway/src/app.ts).
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
    // gateway receives an empty allow-list and its own `new Set({})`/spread
    // over that empty object throws ("Spread syntax requires
    // ...iterable[Symbol.iterator] to be a function"). Rebuild the body as
    // a plain array here so the gateway (packages/ai-providers/src/
    // anthropic-api/provider.ts) gets the real tool names back.
    const withDaemon: ProviderInput = {
      ...input,
      // El default de los providers de terminal es `localhost`, que allá
      // apunta al gateway (y su PORT es el suyo, no el nuestro). Se manda la
      // URL por la que ESTA máquina es alcanzable desde afuera; sin esto un
      // run async remoto arranca sin tools y sin poder reportar el final.
      daemonUrl: input.daemonUrl ?? daemonPublicUrl(),
    }
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
      'remote: POST /v1/run — enviando el run al gateway',
    )

    let res: Response
    try {
      res = await fetch(`${baseUrl}/v1/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: payload,
        // El límite REAL es el AbortSignal: la opción `timeout` de fetch en
        // Bun es booleana (un número no configura milisegundos — verificado
        // empíricamente), así que acá sólo sirve para desarmar el default de
        // 300s del runtime; el corte propio lo impone AbortSignal.timeout,
        // combinado con la cancelación del engine cuando viene.
        signal:
          RUN_TIMEOUT_MS > 0
            ? input.signal
              ? AbortSignal.any([input.signal, AbortSignal.timeout(RUN_TIMEOUT_MS)])
              : AbortSignal.timeout(RUN_TIMEOUT_MS)
            : input.signal,
        timeout: false,
      } as RequestInit)
    } catch (err) {
      // El punto ciego que costó diagnosticar: acá moría el run sin dejar
      // rastro de cuánto había esperado ni contra qué gateway.
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

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      // 503 = el gateway está al tope. Es la contracara de `canAccept`: la
      // sonda admitió y otro dispatch se comió el último slot en la ventana
      // entre sonda y run (es consultiva, no reserva). Tratarlo como error
      // dispararía el `onError` del agente — mover el issue de status y
      // comentar un fallo que no pasó. Se difiere en su lugar.
      if (res.status === 503) {
        throw new ProviderAtCapacityError(
          `RemoteAgentProvider(${this.id}): el gateway está al tope — ${body.slice(0, 200)}`,
          retryAfterMsFrom(res),
        )
      }
      throw new Error(
        `RemoteAgentProvider(${this.id}): ${baseUrl} respondió ${res.status} — ${body.slice(0, 500)}`,
      )
    }

    const output = (await res.json()) as ProviderOutput
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
    // serializar. Se rehidrata contra los endpoints del gateway para que el
    // watchdog y el cancel del orquestador funcionen igual que en local.
    return output.session ? { ...output, session: this.remoteSession(output.session) } : output
  }

  /** Un `SessionHandle` que vive del otro lado del cable. */
  private remoteSession(coords: { kind: SessionHandle['kind']; id: string }): SessionHandle {
    const { baseUrl, token } = this.registration
    const auth = { authorization: `Bearer ${token}` }
    const url = `${baseUrl}/v1/sessions/${encodeURIComponent(coords.id)}`

    return {
      kind: coords.kind,
      id: coords.id,
      // Fail-safe hacia "viva": si no podemos preguntar (gateway caído, red),
      // decir "muerta" haría que el watchdog cierre un run que quizás sigue
      // trabajando. Un run colgado se nota; uno cerrado de más se perdió.
      isAlive: async () => {
        try {
          const res = await fetch(url, { headers: auth, signal: AbortSignal.timeout(5000) })
          if (!res.ok) {
            log.debug(
              { providerId: this.id, sessionId: coords.id, status: res.status },
              'remote: isAlive no pudo preguntar — asumiendo viva',
            )
            return true
          }
          const alive = ((await res.json()) as { alive?: boolean }).alive !== false
          log.debug({ providerId: this.id, sessionId: coords.id, alive }, 'remote: isAlive')
          return alive
        } catch (err) {
          log.debug(
            {
              providerId: this.id,
              sessionId: coords.id,
              err: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
            },
            'remote: isAlive falló — asumiendo viva (fail-safe)',
          )
          return true
        }
      },
      close: async () => {
        log.debug({ providerId: this.id, sessionId: coords.id }, 'remote: cerrando sesión')
        await fetch(url, { method: 'DELETE', headers: auth }).catch((err) => {
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
