import type { Database } from 'bun:sqlite'
import type { Migration } from './runner.js'

const BUILD_IMPLEMENTER_ID = 'lh116-implementer'
const LABEL_CLEANUP_OUTCOME = '$labels:-ci-checked'

const migration: Migration = {
  id: '034-build-label-cleanup',
  description:
    'Agrega onFinishLabels: "$labels:-ci-checked" al entry del lh116-implementer en el status Build ' +
    'de la-haus-116 para que la label ci-checked se quite declarativamente al terminar Build. ' +
    'Permite que el lh116-ci-watcher se re-dispare en el próximo ciclo de Reviewed (gate ' +
    'labels != ci-checked). El snippet bash del lh116-reviewer (migración 033) queda como ' +
    'fallback explícito para movimientos manuales Reviewed → Build.',
  up(db: Database): void {
    const row = db
      .query<{ agents: string }, []>(
        "SELECT agents FROM statuses WHERE project_id = 'la-haus-116' AND name = 'Build'",
      )
      .get()
    // Early-return si la fila no existe (e.g. DB de test vacía o proyecto
    // no seedeado). Sin fila, no hay agents que parchear.
    if (!row) return

    const agents = JSON.parse(row.agents) as Array<Record<string, unknown>>
    // Idempotente: solo agrega onFinishLabels al entry del lh116-implementer
    // si aún no está seteado; nunca sobreescribe un valor distinto ni duplica.
    // Filtrado por agent id para no derramar el outcome a futuros agentes de
    // Build (p.ej. un tester que se agregue después no debería remover la
    // label — eso es responsabilidad del implementer al cerrar el ciclo).
    const updated = agents.map((entry) =>
      entry.agent === BUILD_IMPLEMENTER_ID
        ? { ...entry, onFinishLabels: entry.onFinishLabels ?? LABEL_CLEANUP_OUTCOME }
        : entry,
    )

    db.run("UPDATE statuses SET agents = ? WHERE project_id = 'la-haus-116' AND name = 'Build'", [
      JSON.stringify(updated),
    ])
  },
}

export default migration
