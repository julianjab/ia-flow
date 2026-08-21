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
}

interface ExistingRegistration {
  id: string
  name: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function dropExisting(
  serverUrl: string,
  name: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const res = await fetchImpl(`${serverUrl}/api/provider-registrations`)
  if (!res.ok) return
  const body = (await res.json().catch(() => null)) as {
    registrations?: ExistingRegistration[]
  } | null
  const stale = body?.registrations?.filter((r) => r.name === name) ?? []
  for (const r of stale) {
    await fetchImpl(`${serverUrl}/api/provider-registrations/${r.id}`, { method: 'DELETE' }).catch(
      () => {},
    )
  }
}

interface AttemptParams {
  serverUrl: string
  name: string
  publicUrl: string
  token: string
  fetchImpl: typeof fetch
}

/** Un intento de dar de alta contra un server. Devuelve el id de la
 *  registración creada, o `null` si falló (no lanza — el caller decide si
 *  reintentar). */
async function attemptRegister({
  serverUrl,
  name,
  publicUrl,
  token,
  fetchImpl,
}: AttemptParams): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  try {
    await dropExisting(serverUrl, name, fetchImpl)
    const res = await fetchImpl(`${serverUrl}/api/provider-registrations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, baseUrl: publicUrl, token }),
    })
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

/** No lanza — un self-registro fallido (server abajo, red, lo que sea) no
 *  debe tumbar el boot del gateway, solo queda logueado. */
export async function registerSelf({ log, fetchImpl = fetch }: RegisterDeps): Promise<void> {
  const serversRaw = Bun.env.IA_FLOW_REGISTER_SERVER_URLS
  if (!serversRaw) return

  const publicUrl = Bun.env.IA_FLOW_GATEWAY_PUBLIC_URL
  const token = Bun.env.API_AI_PROVIDER_TOKEN
  const name = Bun.env.IA_FLOW_PROVIDER_NAME
  if (!publicUrl || !token || !name) {
    log.warn(
      {},
      'IA_FLOW_REGISTER_SERVER_URLS seteado pero falta IA_FLOW_GATEWAY_PUBLIC_URL/API_AI_PROVIDER_TOKEN/IA_FLOW_PROVIDER_NAME — no me registro solo',
    )
    return
  }

  const maxAttempts = Number.parseInt(Bun.env.IA_FLOW_REGISTER_RETRIES ?? '5', 10)
  const retryDelayMs = Number.parseInt(Bun.env.IA_FLOW_REGISTER_RETRY_DELAY_MS ?? '2000', 10)
  const servers = serversRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  for (const serverUrl of servers) {
    let result: Awaited<ReturnType<typeof attemptRegister>> | undefined
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      result = await attemptRegister({ serverUrl, name, publicUrl, token, fetchImpl })
      if (result.ok) break
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
    } else {
      log.warn(
        { serverUrl, reason: result?.reason },
        `self-registro falló tras ${maxAttempts} intentos`,
      )
    }
  }
}
