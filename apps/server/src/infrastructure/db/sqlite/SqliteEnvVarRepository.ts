import type { Database } from 'bun:sqlite'
import type { IEnvVarRepository } from '../../../domain/ports/IEnvVarRepository.js'

/**
 * Variables de entorno guardadas desde la pantalla de Configuración, en
 * `global_settings` con la clave prefijada `env.`.
 *
 * ── La regla de precedencia: EL ENTORNO GANA ──────────────────────────────
 *
 * Lo que el proceso recibió del ambiente (el shell, un `.env`, el compose o
 * el `runner.yaml` de un deploy) le gana a lo guardado acá. Es la convención
 * de siempre —el entorno es el override de última milla— y es la única que no
 * obliga a entrar a una UI para explicar por qué el valor del compose no se
 * aplicó.
 *
 * Antes era al revés, y por una razón atendible: si lo guardado no ganaba, la
 * pantalla decía "configurada" mientras el proceso corría otra cosa, y una UI
 * que miente es peor que una que no está. Eso se resolvió de otra forma: la
 * pantalla ahora dice de DÓNDE sale cada valor (`source`) y avisa cuando hay
 * uno guardado que el entorno está tapando. Con la UI diciendo la verdad, la
 * precedencia puede seguir la convención en vez de pelearla.
 *
 * Consecuencia práctica: guardar una variable que el entorno ya define NO
 * cambia lo que corre. La fila queda escrita —vale para cuando esa variable
 * salga del entorno— y la pantalla lo marca en vez de fingir que se aplicó.
 */
export class SqliteEnvVarRepository implements IEnvVarRepository {
  /**
   * Claves cuyo valor en `Bun.env` lo escribimos NOSOTROS (no venían del
   * ambiente). Es lo único que hace falta recordar: como con esta regla nunca
   * pisamos un valor del ambiente, un `Bun.env[key]` que no esté acá es, por
   * construcción, ambiente — y es el que manda.
   */
  #injected = new Set<string>()

  constructor(private db: Database) {}

  /** ¿El ambiente define esta clave? Entonces gana, y lo guardado espera. */
  #envWins(key: string): boolean {
    return Bun.env[key] !== undefined && !this.#injected.has(key)
  }

  get(key: string): string | null {
    const row = this.db
      .query('SELECT value FROM global_settings WHERE key = ?')
      .get(`env.${key}`) as { value: string } | null
    return row?.value ?? null
  }

  set(key: string, value: string): void {
    this.db.run(
      `INSERT INTO global_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [`env.${key}`, value],
    )
    // Guardar no puede pisar al ambiente: sería la misma inversión de
    // precedencia, aplicada a mano. La fila queda escrita igual y
    // `keysOverriddenByEnv` la reporta como guardada-pero-sin-uso.
    if (this.#envWins(key)) return
    ;(Bun.env as Record<string, string>)[key] = value
    this.#injected.add(key)
  }

  delete(key: string): void {
    this.db.run('DELETE FROM global_settings WHERE key = ?', [`env.${key}`])
    // Si el valor en uso es del ambiente, borrar la fila no lo toca: nunca fue
    // nuestro. Sólo se saca del proceso lo que nosotros habíamos inyectado.
    if (!this.#injected.has(key)) return
    delete (Bun.env as Record<string, string | undefined>)[key]
    this.#injected.delete(key)
  }

  loadIntoProcess(): void {
    const rows = this.db
      .query("SELECT key, value FROM global_settings WHERE key LIKE 'env.%'")
      .all() as { key: string; value: string }[]
    for (const { key, value } of rows) {
      const envKey = key.slice(4) // strip "env." prefix
      // El ambiente gana: sólo se rellena lo que no traía.
      if (Bun.env[envKey] !== undefined) continue
      ;(Bun.env as Record<string, string>)[envKey] = value
      this.#injected.add(envKey)
    }
  }

  keysOverriddenByEnv(): string[] {
    const rows = this.db
      .query("SELECT key, value FROM global_settings WHERE key LIKE 'env.%'")
      .all() as { key: string; value: string }[]
    return (
      rows
        .map(({ key, value }) => [key.slice(4), value] as const)
        // Sólo las que DIFIEREN: que el compose repita el mismo valor que está
        // guardado es la situación normal de un deploy, no algo que avisar.
        .filter(([envKey, value]) => this.#envWins(envKey) && Bun.env[envKey] !== value)
        .map(([envKey]) => envKey)
    )
  }
}
