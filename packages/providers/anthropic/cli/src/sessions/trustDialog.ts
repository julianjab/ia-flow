/**
 * El diálogo de confianza de Claude Code ("Is this a project you created or one you trust?"): el
 * CLI interactivo lo muestra la primera vez que abre un directorio, y `--dangerously-skip-permissions`
 * no lo saltea. Cada task corre en un worktree nuevo, así que una sesión de tmux sin nadie mirando
 * quedaba colgada ahí. El launcher mira el panel apenas arranca y, si lo ve, lo acepta: es lo que
 * ya decidió el operador al poner al agente a trabajar en ese worktree.
 */

/** El texto del diálogo, en sus dos versiones ("Yes, I trust this folder" y la vieja "Do you
 *  trust the files in this folder?"). */
const TRUST_PROMPT = /trust (?:this folder|the files in this folder)/i

/** La opción marcada (`❯`) es la de aceptar: Enter elige ésa y no "No, exit". */
const YES_SELECTED = /❯\s*(?:\d+\.\s*)?Yes\b/

/** Si `screen` (lo que muestra el panel) es el diálogo de confianza con "Yes" elegido. */
export function isTrustDialog(screen: string): boolean {
  return TRUST_PROMPT.test(screen) && YES_SELECTED.test(screen)
}

export interface TrustWatch {
  /** Lo que muestra el panel ahora; tira si la sesión ya no existe. */
  capture(): Promise<string>
  /** Manda Enter al panel. */
  confirm(): Promise<void>
  /** Cuánto se mira desde el arranque. Default: 30 s. */
  timeoutMs?: number
  /** Cada cuánto. Default: 500 ms. */
  pollMs?: number
  /** Para de mirar (la sesión se cerró). */
  signal?: AbortSignal
  sleep?: (ms: number) => Promise<void>
}

/**
 * Mira el panel hasta `timeoutMs` y, si aparece el diálogo, lo acepta UNA vez. Devuelve si lo
 * aceptó. Nunca tira: una sesión que ya murió, o que no se pudo leer, sólo deja de mirarse.
 */
export async function acceptTrustDialog(watch: TrustWatch): Promise<boolean> {
  const timeoutMs = watch.timeoutMs ?? 30_000
  const pollMs = watch.pollMs ?? 500
  const sleep =
    watch.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.()))
  for (let waited = 0; waited <= timeoutMs; waited += pollMs) {
    if (watch.signal?.aborted) return false
    try {
      if (isTrustDialog(await watch.capture())) {
        await watch.confirm()
        return true
      }
    } catch {
      return false
    }
    await sleep(pollMs)
  }
  return false
}
