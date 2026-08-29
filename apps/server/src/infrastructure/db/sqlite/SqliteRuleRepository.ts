import type { Database } from 'bun:sqlite'
import type { Rule, RuleActionEntry, WhenCondition } from '@ia-flow/shared'
import type { IRuleRepository } from '../../../domain/ports/IRuleRepository.js'

function rowToRule(r: Record<string, unknown>): Rule {
  return {
    id: r.id as string,
    name: (r.name as string | null) ?? undefined,
    description: (r.description as string | null) ?? undefined,
    on: JSON.parse(r.on_types as string) as string[],
    projectId: (r.project_id as string | null) ?? null,
    repoName: (r.repo_name as string | null) ?? null,
    when: r.when_conditions
      ? (JSON.parse(r.when_conditions as string) as WhenCondition[] | Record<string, string>)
      : undefined,
    whenText: (r.when_text as string | null) ?? undefined,
    enabled: (r.enabled as number) !== 0,
    position: r.position != null ? (r.position as number) : undefined,
    exclusive: (r.exclusive as number) !== 0,
    do: JSON.parse(r.actions as string) as RuleActionEntry[],
    createdAt: (r.created_at as string | null) ?? undefined,
    updatedAt: (r.updated_at as string | null) ?? undefined,
  }
}

export class SqliteRuleRepository implements IRuleRepository {
  constructor(private readonly db: Database) {}

  isReadOnly(): boolean {
    return false
  }

  async visibleTo(projectId?: string): Promise<Rule[]> {
    // Sin projectId, SÓLO las globales. Es el caso de un evento sin scope (un
    // mensaje suelto de Slack): fail-closed, porque lo contrario haría que
    // dispare las reglas de todos los proyectos a la vez.
    const rows = projectId
      ? (this.db
          .query(
            'SELECT * FROM rules WHERE project_id IS NULL OR project_id = ? ORDER BY position, id',
          )
          .all(projectId) as Record<string, unknown>[])
      : (this.db
          .query('SELECT * FROM rules WHERE project_id IS NULL ORDER BY position, id')
          .all() as Record<string, unknown>[])
    return rows.map(rowToRule)
  }

  async list(scope?: { projectId?: string | null; global?: boolean }): Promise<Rule[]> {
    if (scope?.global) {
      return (
        this.db
          .query('SELECT * FROM rules WHERE project_id IS NULL ORDER BY position, id')
          .all() as Record<string, unknown>[]
      ).map(rowToRule)
    }
    if (scope?.projectId) {
      return (
        this.db
          .query('SELECT * FROM rules WHERE project_id = ? ORDER BY position, id')
          .all(scope.projectId) as Record<string, unknown>[]
      ).map(rowToRule)
    }
    return (
      this.db.query('SELECT * FROM rules ORDER BY position, id').all() as Record<string, unknown>[]
    ).map(rowToRule)
  }

  async getById(id: string): Promise<Rule | null> {
    const row = this.db.query('SELECT * FROM rules WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? rowToRule(row) : null
  }

  async upsert(rule: Rule): Promise<Rule> {
    const now = new Date().toISOString()
    const existing = this.db
      .query('SELECT created_at, position FROM rules WHERE id = ?')
      .get(rule.id) as { created_at: string; position: number } | undefined

    // La posición se preserva en un update que no la trae: editar una regla no
    // debería reordenar la lista bajo los pies del operador. Una regla nueva va
    // al final del ámbito, con max+1 y no con `length` — si hay huecos (una
    // regla borrada), `length` colisionaría con una posición ya usada.
    const position =
      rule.position ??
      existing?.position ??
      (
        this.db
          .query('SELECT COALESCE(MAX(position), -1) AS m FROM rules WHERE project_id IS ?')
          .get(rule.projectId ?? null) as { m: number }
      ).m + 1

    this.db.run(
      `INSERT INTO rules (
         id, name, description, on_types, project_id, repo_name,
         when_conditions, when_text, enabled, position, exclusive, actions,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         description = excluded.description,
         on_types = excluded.on_types,
         project_id = excluded.project_id,
         repo_name = excluded.repo_name,
         when_conditions = excluded.when_conditions,
         when_text = excluded.when_text,
         enabled = excluded.enabled,
         position = excluded.position,
         exclusive = excluded.exclusive,
         actions = excluded.actions,
         updated_at = excluded.updated_at`,
      [
        rule.id,
        rule.name ?? null,
        rule.description ?? null,
        JSON.stringify(rule.on),
        rule.projectId ?? null,
        rule.repoName ?? null,
        rule.when ? JSON.stringify(rule.when) : null,
        rule.whenText ?? null,
        rule.enabled === false ? 0 : 1,
        position,
        rule.exclusive ? 1 : 0,
        JSON.stringify(rule.do),
        existing?.created_at ?? now,
        now,
      ],
    )

    const saved = await this.getById(rule.id)
    if (!saved) throw new Error(`rule ${rule.id} vanished right after upsert`)
    return saved
  }

  async deleteById(id: string): Promise<boolean> {
    const res = this.db.run('DELETE FROM rules WHERE id = ?', [id])
    return res.changes > 0
  }

  async setPositions(ids: string[]): Promise<void> {
    // Transaccional: un reorden a medias dejaría dos reglas compartiendo
    // posición, y el desempate por `id` haría que el orden que ve el operador
    // no sea el que aplica el matcher.
    this.db.transaction(() => {
      ids.forEach((id, index) => {
        this.db.run('UPDATE rules SET position = ? WHERE id = ?', [index, id])
      })
    })()
  }
}
