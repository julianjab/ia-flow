// La forma de lo que se guarda en `servers.json`, y su validación.
//
// Vive fuera de main.ts para poder testearse sin levantar Electron. No es una
// separación cosmética: este archivo decide qué se escribe sobre la ÚNICA copia
// en disco de la lista de servers y sus tokens, y ya se rompió dos veces —
// primero guardando en silencio (un chequeo de origen que nunca matcheaba) y
// después escribiendo `[]` porque el renderer empezó a mandar un objeto y el
// handler seguía esperando un array. Las dos veces el síntoma fue el mismo:
// los servers desaparecen sin un error.

/** Un server declarado por el usuario. Espejo de `SavedServer` en apps/web. */
export interface StoredServer {
  baseUrl: string
  label?: string
  token?: string
}

/**
 * La lista más CUÁNDO se escribió.
 *
 * La revisión es lo que deja que dos backends (este archivo y el localStorage
 * de la ventana) convivan sin pelearse: gana la escritura más nueva, aunque sea
 * más corta — que es el caso de borrar. Ver `storage.ts` en apps/web.
 */
export interface StoredList {
  rev: number
  servers: StoredServer[]
}

function toServers(raw: unknown): StoredServer[] {
  if (!Array.isArray(raw)) return []
  const out: StoredServer[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const { baseUrl, label, token } = entry as Record<string, unknown>
    if (typeof baseUrl !== 'string' || !baseUrl.trim()) continue
    out.push({
      baseUrl: baseUrl.trim(),
      ...(typeof label === 'string' && label ? { label } : {}),
      ...(typeof token === 'string' && token ? { token } : {}),
    })
  }
  return out
}

/**
 * Normaliza cualquier cosa que llegue —del disco o del renderer— a la forma
 * canónica.
 *
 * Acepta el formato viejo (un array pelado) como la revisión más vieja posible,
 * así una lista guardada antes de que existiera `rev` se conserva y la primera
 * escritura nueva la reemplaza.
 *
 * Nunca tira: esto corre sobre un archivo que alguien pudo editar a mano y
 * sobre un mensaje de IPC. Descartar una entrada rota es recuperable tipeándola;
 * una excepción acá deja la app sin lista y sin forma de arreglarla.
 */
export function normalizeList(raw: unknown): StoredList {
  if (Array.isArray(raw)) return { rev: 0, servers: toServers(raw) }
  if (raw && typeof raw === 'object') {
    const { rev, servers } = raw as Record<string, unknown>
    return {
      rev: typeof rev === 'number' && Number.isFinite(rev) && rev > 0 ? rev : 0,
      servers: toServers(servers),
    }
  }
  return { rev: 0, servers: [] }
}
