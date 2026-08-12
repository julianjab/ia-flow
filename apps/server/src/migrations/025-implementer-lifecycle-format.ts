import type { Database } from 'bun:sqlite'
import type { Migration } from './runner.js'

// Reescribe la sección "Progress tracking" del implementer para alinear el
// prompt con el nuevo input estructurado de complete_task / fail_task (ver
// apps/server/src/tools/task.ts). Mantiene el resto del prompt intacto —
// solo sustituye el bloque de cierre.
//
// Idempotente: si el marcador `what_did` ya aparece en el prompt asumimos
// que la migración ya se aplicó (o el operador ya alineó el texto a mano)
// y salimos sin escribir.
const OLD_PROGRESS_BLOCK = `When fully done, call \`complete_task\` with \`task_id\` = \`{{task.id}}\` and a summary including the PR URL.
If you cannot complete the task, call \`fail_task\` with \`task_id\` = \`{{task.id}}\` and a description of what blocked you.`

const NEW_PROGRESS_BLOCK = `When fully done, call \`complete_task\` with:
- \`task_id\` = \`{{task.id}}\`
- \`what_did\`: bullets con lo hecho (archivos tocados, PR URL, comandos ejecutados, decisiones clave). Un ítem por bullet.
- \`validations\`: bullets con las validaciones corridas y su resultado (bun test, biome, tsc, curl al endpoint, prueba manual, etc.).
- \`notes\` (opcional): contexto adicional que no encaje en Qué hice / Validaciones.

If you cannot complete the task, call \`fail_task\` with:
- \`task_id\` = \`{{task.id}}\`
- \`what_tried\`: bullets con lo que intentaste antes de rendirte.
- \`where_failed\`: descripción concreta del punto de fallo (mensaje de error, comando, archivo).
- \`validations\`: bullets con las validaciones que sí corriste y su resultado.

Ambas tools son internas: no las declaras en \`tools\`, el engine las inyecta automáticamente.`

const migration: Migration = {
  id: '025-implementer-lifecycle-format',
  description:
    'Reescribe el cierre del prompt del implementer para usar el input estructurado de complete_task/fail_task',
  up(db: Database): void {
    const row = db.query("SELECT prompt FROM agents WHERE id = 'implementer'").get() as
      | { prompt: string }
      | undefined
    if (!row) return
    if (row.prompt.includes('what_did')) return // already aligned
    if (!row.prompt.includes(OLD_PROGRESS_BLOCK)) return // custom prompt — don't clobber

    const next = row.prompt.replace(OLD_PROGRESS_BLOCK, NEW_PROGRESS_BLOCK)
    db.run(`UPDATE agents SET prompt = ? WHERE id = 'implementer'`, [next])
  },
}

export default migration
