import type { EnvVarState } from '@/features/env-vars/api'

/**
 * Qué mandar en el `PUT /api/env-vars`: **sólo lo que el operador cambió.**
 *
 * Antes el form mandaba TODAS las variables no secretas, tocadas o no. El
 * problema es de dónde sale el valor que el input muestra: una variable
 * declarada en el entorno del proceso —o volcada desde un `runner.yaml` por
 * `applyRunnerEnv`— llega pre-cargada igual que una guardada. Mandarla de
 * vuelta la persistía en `global_settings` sin que nadie lo pidiera: un
 * `Guardar` hecho para cambiar OTRO campo dejaba una copia del `daemonMode`
 * del deploy en la DB.
 *
 * Hoy esa copia ya no cambia lo que corre —el entorno gana, ver
 * `SqliteEnvVarRepository`— pero sigue siendo basura que reaparece el día que
 * la variable salga del entorno, con un valor que nadie eligió.
 *
 * La comparación es contra el borrador inicial (`pristine`), no contra
 * `state.value`: son el mismo dato, pero el borrador es lo que el input
 * realmente mostró, así que "cambió" significa "cambió en pantalla".
 *
 * Las secretas ya se comportaban bien y siguen igual — su `pristine` es
 * siempre `''` porque el GET nunca devuelve su valor, así que compararlas
 * mandaría cualquier texto y omitiría el vacío, que es exactamente la regla
 * que ya tenían. Se deja explícita igual: "vacío = conservar" es una decisión
 * del contrato con el backend (que interpreta `''` como borrar), no una
 * consecuencia de cómo quedó el diff.
 */
export function buildEnvPatch(
  vars: Record<string, EnvVarState>,
  drafts: Record<string, string>,
  pristine: Record<string, string>,
): Record<string, string> {
  const patch: Record<string, string> = {}
  for (const [key, state] of Object.entries(vars)) {
    const draft = drafts[key] ?? ''
    if (state.secret) {
      // El GET nunca devuelve un secreto, así que el input arranca vacío y
      // vacío significa "conservar el valor actual" (es lo que dice su
      // placeholder). Ojo con la contracara: desde este form NO hay forma de
      // borrar un secreto — para eso hace falta el `''` explícito que sólo
      // manda una no-secreta vaciada.
      if (draft.trim()) patch[key] = draft.trim()
    } else if (draft !== (pristine[key] ?? '')) {
      // Incluye el caso "la vacié": va como `''` y el backend la borra de la
      // DB y del proceso. Por eso la condición es "distinto del inicial" y no
      // "no vacío".
      patch[key] = draft
    }
  }
  return patch
}
