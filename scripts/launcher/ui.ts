import { writeFileSync } from 'node:fs'

// Diálogos nativos de macOS vía osascript. El launcher corre sin terminal
// (lo abre el Finder), así que cualquier pregunta o error tiene que salir por
// acá o el usuario no ve nada.

function osascript(script: string): { ok: boolean; out: string } {
  const proc = Bun.spawnSync(['osascript', '-e', script], { stdout: 'pipe', stderr: 'pipe' })
  return { ok: proc.success, out: proc.stdout.toString().trim() }
}

function quote(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Selector de lista. Devuelve null si el usuario cancela — quien llama decide
 * si eso es "no hagas nada" o "usá el default".
 */
export function chooseFromList(
  items: string[],
  opts: { title: string; prompt: string; defaultItem?: string },
): string | null {
  if (items.length === 0) return null
  const list = items.map((i) => `"${quote(i)}"`).join(', ')
  const def = opts.defaultItem ? ` default items {"${quote(opts.defaultItem)}"}` : ''
  const { ok, out } = osascript(
    `choose from list {${list}} with title "${quote(opts.title)}" ` +
      `with prompt "${quote(opts.prompt)}"${def}`,
  )
  if (!ok || out === 'false' || out === '') return null
  return out
}

export function confirm(message: string, opts?: { okLabel?: string }): boolean {
  const okLabel = opts?.okLabel ?? 'Continuar'
  const { ok, out } = osascript(
    `display dialog "${quote(message)}" buttons {"Cancelar", "${quote(okLabel)}"} ` +
      `default button "${quote(okLabel)}" with title "IA Flow"`,
  )
  return ok && out.includes(okLabel)
}

export function alert(message: string): void {
  osascript(
    `display dialog "${quote(message)}" buttons {"OK"} default button "OK" with title "IA Flow"`,
  )
}

export function notify(message: string, title = 'IA Flow'): void {
  osascript(`display notification "${quote(message)}" with title "${quote(title)}"`)
}

/**
 * ¿Está apretada la tecla Option en este instante? Es el gesto para forzar el
 * selector en vez de repetir la última elección. Si el bridge de ObjC falla
 * (macOS futuro, permisos), devolvemos false: se pierde el atajo, no la app.
 */
export function optionKeyHeld(): boolean {
  const proc = Bun.spawnSync(
    [
      'osascript',
      '-l',
      'JavaScript',
      '-e',
      "ObjC.import('AppKit'); ($.NSEvent.modifierFlags & $.NSEventModifierFlagOption) != 0",
    ],
    { stdout: 'pipe', stderr: 'ignore' },
  )
  return proc.success && proc.stdout.toString().trim() === 'true'
}

/**
 * Abre una ventana de Terminal corriendo `command`. El launcher termina apenas
 * la abre — los procesos largos (web, gateway) viven en esa ventana, donde el
 * usuario ve los logs y los corta con Ctrl+C.
 *
 * Va por un .command + `open`, no por AppleScript: manejar Terminal con Apple
 * events exige permiso de Automatización (TCC) y, sin él, falla en silencio —
 * el usuario haría clic en la app y no pasaría nada. `open` no pide nada.
 */
export function openInTerminal(command: string, scriptPath: string): boolean {
  // El PATH viaja al script a propósito: Terminal ejecuta un .command con un
  // bash NO-login, así que hereda el PATH pelado del sistema — sin `bun`, sin
  // `podman`. El nuestro ya viene arreglado por el launcher del bundle.
  writeFileSync(
    scriptPath,
    [
      '#!/bin/bash',
      '# Generado por IA Flow.app en cada arranque — se pisa solo.',
      `export PATH=${JSON.stringify(process.env.PATH ?? '')}`,
      'clear',
      command,
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  const proc = Bun.spawnSync(['open', '-a', 'Terminal', scriptPath], { stderr: 'pipe' })
  return proc.success
}
