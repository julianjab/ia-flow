// Self-registro: al bootear, si están seteados los env vars de abajo, esta
// instancia se da de alta sola contra uno o más servers vía
// POST /api/provider-registrations — el server se entera de que existe un
// provider llamado X, nunca cómo resuelve X qué corre (eso es 100% interno
// al gateway, ver providers.ts). Sin esto, el registro es manual (curl a
// mano) cada vez que el gateway reinicia — ver README.md.
//
// Idempotente por boot: antes de darse de alta, borra cualquier
// registración previa con el MISMO name en ese server — un restart no debe
// ir acumulando filas viejas apuntando a un baseUrl/token que ya no valen.
//
// Reintenta cada server por separado (IA_FLOW_REGISTER_RETRIES intentos,
// IA_FLOW_REGISTER_RETRY_DELAY_MS entre uno y el siguiente) — pensado para
// el arranque en frío de un docker-compose con los dos servicios (gateway +
// server) subiendo a la vez: el server puede tardar unos segundos en correr
// migraciones y empezar a escuchar, y sin retry el primer intento del
// gateway llegaría antes y se perdería la registración hasta el próximo
// restart manual.
import type { Log } from './logger.js'

export interface RegisterDeps {
  log: Log
  fetchImpl?: typeof fetch
  /** Servers a los que darse de alta. Sin esto, los del env (arranque frío). */
  serverUrls?: string[]
  /**
   * Por qué URL ESE server alcanza a este gateway. Pisa
   * `IA_FLOW_GATEWAY_PUBLIC_URL`, que es un solo valor y no puede servir para
   * dos servers que ven esta máquina distinto: uno en el host la alcanza por
   * `localhost`, uno dentro de un container necesita
   * `host.containers.internal`.
   */
  publicUrl?: string
}

export interface RegisterResult {
  serverUrl: string
  ok: boolean
  id?: string
  reason?: string
  /** Con qué URL se anunció — lo que el server va a usar para alcanzarlo. */
  publicUrl?: string
}

/** La identidad con la que este gateway se presenta ante un server. */
function identity(): { publicUrl: string; token: string; name: string } | null {
  const publicUrl = Bun.env.IA_FLOW_GATEWAY_PUBLIC_URL
  const token = Bun.env.API_AI_PROVIDER_TOKEN
  const name = Bun.env.IA_FLOW_PROVIDER_NAME
  return publicUrl && token && name ? { publicUrl, token, name } : null
}

interface ExistingRegistration {
  id: string
  name: string
  /** Necesario para reponerla si el reemplazo falla. */
  baseUrl?: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Las registraciones con NUESTRO name que ese server tiene ahora mismo. */
async function findExisting(
  serverUrl: string,
  name: string,
  fetchImpl: typeof fetch,
): Promise<ExistingRegistration[]> {
  const res = await fetchImpl(`${serverUrl}/api/provider-registrations`)
  if (!res.ok) return []
  const body = (await res.json().catch(() => null)) as {
    registrations?: ExistingRegistration[]
  } | null
  return body?.registrations?.filter((r) => r.name === name) ?? []
}

async function dropExisting(
  serverUrl: string,
  name: string,
  fetchImpl: typeof fetch,
): Promise<ExistingRegistration[]> {
  const stale = await findExisting(serverUrl, name, fetchImpl)
  for (const r of stale) {
    await fetchImpl(`${serverUrl}/api/provider-registrations/${r.id}`, { method: 'DELETE' }).catch(
      () => {},
    )
  }
  return stale
}

/**
 * Vuelve a crear lo que borramos, con su baseUrl original. El token es el
 * mismo con el que nos estábamos registrando: esas filas las creó este mismo
 * gateway, y el server nunca lo devuelve en el GET.
 */
async function restore(
  serverUrl: string,
  name: string,
  dropped: ExistingRegistration[],
  params: { token: string; fetchImpl: typeof fetch },
): Promise<void> {
  for (const old of dropped) {
    if (!old.baseUrl) continue
    await postRegistration({
      serverUrl,
      name,
      publicUrl: old.baseUrl,
      token: params.token,
      fetchImpl: params.fetchImpl,
    }).catch(() => {})
  }
}

/**
 * Hosts por los que OTRO proceso puede alcanzar a esta máquina, en orden de
 * probabilidad. `localhost` sirve para un server que corre en el mismo host;
 * los otros dos son cómo un container ve a su host (Podman y Docker Desktop
 * usan nombres distintos).
 */
const REACHABLE_HOSTS = ['host.containers.internal', 'host.docker.internal']

/**
 * El server valida la publicUrl alcanzándola, y cuando no puede lo dice con
 * todas las letras. Es una señal precisa: no hay que adivinar si el problema
 * fue la URL o cualquier otra cosa.
 */
function looksUnreachable(reason: string): boolean {
  return /no se pudo alcanzar|unable to connect|econnrefused|failed to fetch/i.test(reason)
}

/**
 * Las otras URLs por las que ese server podría alcanzarnos, cuando la que
 * probamos no le sirvió.
 *
 * Existe para que no haya que pedirle al usuario dos URLs: una sola describe
 * dónde está el server, y de qué lado del container vive esta máquina se
 * descubre probando. Sólo se reescribe un host local — si alguien puso una IP
 * o un nombre propio, es una decisión deliberada y no se toca.
 */
function alternativePublicUrls(publicUrl: string): string[] {
  let url: URL
  try {
    url = new URL(publicUrl)
  } catch {
    return []
  }
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)) return []
  return REACHABLE_HOSTS.map((host) => {
    const alt = new URL(publicUrl)
    alt.hostname = host
    return alt.toString().replace(/\/$/, '')
  })
}

interface AttemptParams {
  serverUrl: string
  name: string
  publicUrl: string
  token: string
  fetchImpl: typeof fetch
}

async function postRegistration({
  serverUrl,
  name,
  publicUrl,
  token,
  fetchImpl,
}: AttemptParams): Promise<Response> {
  return fetchImpl(`${serverUrl}/api/provider-registrations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, baseUrl: publicUrl, token }),
  })
}

/** Un intento de dar de alta contra un server. Devuelve el id de la
 *  registración creada, o `null` si falló (no lanza — el caller decide si
 *  reintentar). */
async function attemptRegister(
  params: AttemptParams,
): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  const { serverUrl, name, fetchImpl } = params
  try {
    // Se intenta el alta ANTES de borrar la vieja, y sólo se borra si el
    // server dice que ya existe una con este name (409). Al revés — que era
    // como estaba — un POST que falla por cualquier otro motivo (una publicUrl
    // que el server no alcanza, por ejemplo) te dejaba sin la registración que
    // venía andando.
    let res = await postRegistration(params)
    if (res.status === 409) {
      // Ya hay una con este name. Hay que borrarla para poder crear la nueva,
      // pero el reintento puede fallar igual (una publicUrl que ese server no
      // alcanza, por ejemplo) — y ahí el operador se quedaría SIN NINGUNA,
      // que es peor que antes de intentar. Por eso se guarda lo borrado y se
      // repone si el reintento no entra.
      const dropped = await dropExisting(serverUrl, name, fetchImpl)
      res = await postRegistration(params)
      if (!res.ok) await restore(serverUrl, name, dropped, params)
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { ok: false, reason: `${res.status}: ${text.slice(0, 300)}` }
    }
    const { registration } = (await res.json()) as { registration: { id: string } }
    return { ok: true, id: registration.id }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Da de baja este gateway en un server. Es la contracara del alta: borra por
 * `name`, que es la identidad estable de esta instancia (el `id` lo elige el
 * server y cambia en cada alta).
 */
export async function unregisterFrom(
  serverUrl: string,
  { log, fetchImpl = fetch }: RegisterDeps,
): Promise<RegisterResult> {
  const id = identity()
  if (!id) return { serverUrl, ok: false, reason: 'falta IA_FLOW_PROVIDER_NAME' }
  try {
    await dropExisting(serverUrl, id.name, fetchImpl)
    log.info({ serverUrl, name: id.name }, 'desregistrado')
    return { serverUrl, ok: true }
  } catch (err) {
    return { serverUrl, ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/** No lanza — un self-registro fallido (server abajo, red, lo que sea) no
 *  debe tumbar el boot del gateway, solo queda logueado. */
export async function registerSelf({
  log,
  fetchImpl = fetch,
  serverUrls,
  publicUrl: publicUrlOverride,
}: RegisterDeps): Promise<RegisterResult[]> {
  const servers =
    serverUrls ??
    (Bun.env.IA_FLOW_REGISTER_SERVER_URLS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  if (servers.length === 0) return []

  const id = identity()
  if (!id) {
    log.warn(
      {},
      'hay servers para registrarse pero falta IA_FLOW_GATEWAY_PUBLIC_URL/API_AI_PROVIDER_TOKEN/IA_FLOW_PROVIDER_NAME — no me registro solo',
    )
    return servers.map((serverUrl) => ({
      serverUrl,
      ok: false,
      reason: 'falta publicUrl/token/name en el entorno',
    }))
  }
  const { token, name } = id
  const publicUrl = publicUrlOverride ?? id.publicUrl

  const maxAttempts = Number.parseInt(Bun.env.IA_FLOW_REGISTER_RETRIES ?? '5', 10)
  const retryDelayMs = Number.parseInt(Bun.env.IA_FLOW_REGISTER_RETRY_DELAY_MS ?? '2000', 10)
  const results: RegisterResult[] = []

  for (const serverUrl of servers) {
    let result: Awaited<ReturnType<typeof attemptRegister>> | undefined
    let usedPublicUrl = publicUrl
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      result = await attemptRegister({
        serverUrl,
        name,
        publicUrl: usedPublicUrl,
        token,
        fetchImpl,
      })
      if (result.ok) break

      // El server no nos alcanza por esa URL: probablemente vive dentro de un
      // container y le dijimos "localhost". Se prueban las alternativas antes
      // de gastar el reintento — reintentar la misma URL daría lo mismo.
      if (looksUnreachable(result.reason)) {
        for (const alt of alternativePublicUrls(usedPublicUrl)) {
          const retried = await attemptRegister({
            serverUrl,
            name,
            publicUrl: alt,
            token,
            fetchImpl,
          })
          if (retried.ok) {
            log.info({ serverUrl, publicUrl: alt }, 'ese server nos alcanza por otra URL')
            result = retried
            usedPublicUrl = alt
            break
          }
        }
        if (result.ok) break
      }
      if (attempt < maxAttempts) {
        log.warn(
          { serverUrl, attempt, maxAttempts, reason: result.reason },
          'self-registro falló, reintentando',
        )
        await sleep(retryDelayMs)
      }
    }
    if (result?.ok) {
      log.info({ serverUrl, id: result.id, name }, 'self-registro ok')
      results.push({ serverUrl, ok: true, id: result.id, publicUrl: usedPublicUrl })
    } else {
      log.warn(
        { serverUrl, reason: result?.reason },
        `self-registro falló tras ${maxAttempts} intentos`,
      )
      results.push({ serverUrl, ok: false, reason: result?.reason, publicUrl: usedPublicUrl })
    }
  }

  return results
}
