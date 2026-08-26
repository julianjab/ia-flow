import { memoize } from '@ia-flow/shared'
import type { SlackMemberRef } from '@ia-flow/shared'
import { conversationsList, usersList } from '@ia-flow/tools'
import { createLogger } from '../../logger.js'

const log = createLogger('slack-directory')

// Directorio del workspace de Slack: quién puede ser reviewer y en qué canal
// se pide el review. Existe porque **Slack no tiene búsqueda server-side de
// usuarios** — `users.list` devuelve el workspace entero y el filtro es
// nuestro. Listar en cada tecla del autocomplete sería absurdo, así que se
// lista una vez y se memoiza por TTL.
//
// El cache es `@memoize` y no un Map a mano: es exactamente el caso para el
// que existe (ver el CLAUDE.md), y muere con la instancia sin teardown.

const TTL_MS = 10 * 60 * 1000
const PAGE = 200
// `users.list` pagina hasta agotar el workspace. El tope existe para que un
// workspace enorme no convierta un autocomplete en una decena de requests.
const MAX_PAGES = 20

export interface SlackChannelRef {
  id: string
  name: string
  isPrivate?: boolean
}

export class SlackDirectory {
  @memoize({ ttlMs: TTL_MS, key: () => 'members', bypass: (o?: Opts) => o?.refresh === true })
  private async loadMembers(_opts?: Opts): Promise<SlackMemberRef[]> {
    const out: SlackMemberRef[] = []
    let cursor: string | undefined
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await usersList({ limit: PAGE, cursor })
      for (const u of res.members ?? []) {
        // Un usuario borrado ya no puede recibir el tag, y Slackbot no es un
        // revisor. Los BOTS SÍ entran: taguear al bot revisor es medio caso de
        // uso de esto.
        if (u.deleted || u.id === 'USLACKBOT') continue
        out.push({
          id: u.id,
          name: displayName(u),
          ...(u.is_bot ? { isBot: true } : {}),
        })
      }
      cursor = res.response_metadata?.next_cursor || undefined
      if (!cursor) break
    }
    return out.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
  }

  /**
   * Canales del workspace.
   *
   * Se piden los tipos **por separado** y no en un solo `types:` a propósito:
   * los privados necesitan `groups:read` y los públicos `channels:read`, y con
   * un solo request un scope faltante hace fallar la llamada entera — el picker
   * quedaba sin NINGÚN canal por no poder ver los privados. Cada tipo que falla
   * deja su motivo en `warnings` y el otro sigue.
   */
  @memoize({ ttlMs: TTL_MS, key: () => 'channels', bypass: (o?: Opts) => o?.refresh === true })
  private async loadChannels(_opts?: Opts): Promise<{
    channels: SlackChannelRef[]
    warnings: string[]
  }> {
    const out: SlackChannelRef[] = []
    const warnings: string[] = []

    for (const type of ['public_channel', 'private_channel']) {
      let cursor: string | undefined
      try {
        for (let page = 0; page < MAX_PAGES; page++) {
          const res = await conversationsList({
            types: type,
            exclude_archived: true,
            limit: PAGE,
            cursor,
          })
          for (const ch of res.channels ?? []) {
            if (ch.is_archived) continue
            out.push({ id: ch.id, name: ch.name, ...(ch.is_private ? { isPrivate: true } : {}) })
          }
          cursor = res.response_metadata?.next_cursor || undefined
          if (!cursor) break
        }
      } catch (err) {
        // Lo que ya se juntó vale: media lista es mejor que ninguna, y el
        // motivo llega a la UI para que "faltan canales" sea diagnosticable.
        const msg = (err as Error).message
        warnings.push(`${type}: ${msg}`)
        log.warn({ type, err: msg }, 'No se pudieron listar canales de este tipo')
      }
    }
    return { channels: out.sort((a, b) => a.name.localeCompare(b.name)), warnings }
  }

  /**
   * Miembros que matchean `q` (substring, case-insensitive, sobre el nombre y
   * el id). Sin query devuelve el principio de la lista, que es lo que el
   * autocomplete muestra al abrirse.
   *
   * Fail-open: si Slack no está configurado (o falta `users:read`) devuelve
   * vacío y lo loguea. Un picker vacío es un problema del operador; una
   * excepción acá rompería el editor de repos entero.
   */
  async searchMembers(q: string, limit = 20): Promise<SlackMemberRef[]> {
    return filter(await this.safe(() => this.loadMembers()), q, limit, (m) => [m.name, m.id])
  }

  /**
   * Canales que matchean `q`, más el motivo por el que la lista podría estar
   * incompleta. Devolver `warnings` es lo que convierte "faltan canales" en algo
   * que el operador puede arreglar (casi siempre: un scope, o el bot que no está
   * invitado al canal privado) en vez de un misterio.
   */
  async searchChannels(
    q: string,
    limit = 20,
  ): Promise<{ channels: SlackChannelRef[]; warnings: string[] }> {
    let loaded: { channels: SlackChannelRef[]; warnings: string[] }
    try {
      loaded = await this.loadChannels()
    } catch (err) {
      const msg = (err as Error).message
      log.warn({ err: msg }, 'Slack directory no disponible')
      return { channels: [], warnings: [msg] }
    }
    return {
      channels: filter(loaded.channels, q, limit, (c) => [c.name, c.id]),
      warnings: loaded.warnings,
    }
  }

  private async safe<T>(run: () => Promise<T[]>): Promise<T[]> {
    try {
      return await run()
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'Slack directory no disponible')
      return []
    }
  }
}

interface Opts {
  refresh?: boolean
}

function displayName(u: {
  name?: string
  real_name?: string
  profile?: { display_name?: string; real_name?: string }
}): string {
  return u.profile?.display_name || u.profile?.real_name || u.real_name || u.name || ''
}

function filter<T>(
  items: T[],
  q: string,
  limit: number,
  fields: (item: T) => Array<string | undefined>,
): T[] {
  const needle = q.trim().toLowerCase()
  if (!needle) return items.slice(0, limit)
  return items
    .filter((item) => fields(item).some((f) => f?.toLowerCase().includes(needle)))
    .slice(0, limit)
}
