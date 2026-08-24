// Memoria del launcher: qué eligió el usuario la última vez. Es lo que hace
// que un doble clic levante "lo último" sin preguntar nada.

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { STATE_FILE } from './paths.ts'

export type LauncherState = {
  /** baseUrl del server al que apunta la web. */
  webServer?: string
  /** baseUrl del server contra el que se registra el gateway. */
  gatewayServer?: string
  /** false = el usuario no quiere gateway en este flujo. */
  gatewayEnabled?: boolean
  /** Último puerto que usó el dev server de Vite. */
  webPort?: number
  /**
   * Lo que hay corriendo AHORA, escrito por run.ts al arrancar y borrado al
   * salir. Es lo que deja que un segundo clic en la app abra el navegador en
   * vez de levantar una segunda copia de todo.
   */
  running?: { pid: number; port: number; webServer: string } | null
}

export async function loadState(): Promise<LauncherState> {
  try {
    const text = await Bun.file(STATE_FILE).text()
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as LauncherState) : {}
  } catch {
    return {}
  }
}

export async function saveState(patch: LauncherState): Promise<void> {
  const next = { ...(await loadState()), ...patch }
  mkdirSync(dirname(STATE_FILE), { recursive: true })
  await Bun.write(STATE_FILE, `${JSON.stringify(next, null, 2)}\n`)
}
