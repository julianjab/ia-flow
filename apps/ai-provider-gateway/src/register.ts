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
import type { Log } from './logger.js'

export interface RegisterDeps {
  log: Log
  fetchImpl?: typeof fetch
}

interface ExistingRegistration {
  id: string
  name: string
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

  const servers = serversRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  for (const serverUrl of servers) {
    try {
      await dropExisting(serverUrl, name, fetchImpl)
      const res = await fetchImpl(`${serverUrl}/api/provider-registrations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, baseUrl: publicUrl, token }),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        log.warn({ serverUrl, status: res.status, body: text.slice(0, 300) }, 'self-registro falló')
        continue
      }
      const { registration } = (await res.json()) as { registration: { id: string } }
      log.info({ serverUrl, id: registration.id, name }, 'self-registro ok')
    } catch (err) {
      log.warn(
        { serverUrl, err: err instanceof Error ? err.message : String(err) },
        'self-registro falló (fetch)',
      )
    }
  }
}
