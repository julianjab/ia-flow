// El portapapeles de la Mac, servido por mac-pulse (`GET /api/clipboard`): lo que se copia allá queda a un
// toque para pegarlo acá, en cualquier pantalla. mac-pulse responde con CORS a esta web; por el túnel las dos
// son subdominios de julianjab.link, así que el navegador manda la cookie de Cloudflare Access de mac-pulse
// (si nunca se entró a mac-pulse en este navegador, Access redirige y la pastilla simplemente no aparece).

export type MacClip = { id: string; text: string; at: number; truncated: boolean }

/** Pasado este tiempo desde que se copió, la pastilla ya no se ofrece. */
export const CLIP_TTL_MS = 10 * 60_000

/**
 * Dónde está mac-pulse: `VITE_MAC_PULSE_URL` si se configuró; si no, servida bajo julianjab.link se asume el
 * suyo. En cualquier otro lado (localhost, el visor de escritorio) no hay pastilla: ya se está en la Mac.
 */
export function macPulseBase(configured: string | undefined, hostname: string): string | null {
  const url = configured?.trim()
  if (url) return url.replace(/\/+$/, '')
  return hostname.endsWith('.julianjab.link') ? 'https://mac-pulse.julianjab.link' : null
}

export type FetchResult =
  | { kind: 'clip'; clip: MacClip | null }
  | { kind: 'same' }
  | { kind: 'no-session' }
  | { kind: 'error' }

/** Pide lo último copiado; con `since` (el id que ya se tiene) mac-pulse contesta 204 si no cambió. */
export async function fetchClip(
  base: string,
  since: string | null,
  doFetch: typeof fetch = fetch,
): Promise<FetchResult> {
  const url = `${base}/api/clipboard${since ? `?since=${encodeURIComponent(since)}` : ''}`
  try {
    // sin headers propios: es un GET «simple», sin preflight que Access tenga que dejar pasar
    const r = await doFetch(url, { credentials: 'include', redirect: 'manual', cache: 'no-store' })
    if (r.status === 204) return { kind: 'same' }
    // la redirección al login de Access, o mac-pulse sin sesión
    if (r.type === 'opaqueredirect' || r.status === 401) return { kind: 'no-session' }
    if (!r.ok) return { kind: 'error' }
    const body = (await r.json()) as { clip?: MacClip | null }
    return { kind: 'clip', clip: body.clip ?? null }
  } catch {
    // CORS (la redirección de Access a otro origen) o sin red: no se distingue desde acá
    return { kind: 'error' }
  }
}

/** Se ofrece si es nuevo (no se usó ni se descartó) y no es viejo. */
export function shouldShow(
  clip: MacClip | null,
  seenId: string | null,
  now: number,
): clip is MacClip {
  return !!clip && clip.id !== seenId && now - clip.at < CLIP_TTL_MS
}

type TextField = HTMLInputElement | HTMLTextAreaElement

/** Un campo donde se puede pegar texto: textarea o input de texto, habilitado y editable. */
export function isTextField(el: EventTarget | null): el is TextField {
  if (el instanceof HTMLTextAreaElement) return !el.disabled && !el.readOnly
  if (el instanceof HTMLInputElement)
    return ['text', 'search', 'url', 'email', ''].includes(el.type) && !el.disabled && !el.readOnly
  return false
}

/** Pega `text` donde está el cursor (o reemplaza la selección) y avisa con `input`, para que v-model lo vea. */
export function insertAt(field: TextField, text: string) {
  const start = field.selectionStart ?? field.value.length
  const end = field.selectionEnd ?? field.value.length
  field.value = field.value.slice(0, start) + text + field.value.slice(end)
  field.dispatchEvent(new Event('input', { bubbles: true }))
  field.focus()
  field.setSelectionRange(start + text.length, start + text.length)
}

const SEEN_KEY = 'ia-flow:mac-clip-seen'

export function readSeen(): string | null {
  try {
    return localStorage.getItem(SEEN_KEY)
  } catch {
    return null
  }
}

export function writeSeen(id: string) {
  try {
    localStorage.setItem(SEEN_KEY, id)
  } catch {}
}
