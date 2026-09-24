/**
 * `Map<string, T> + register/resolve/list/reset` — la forma que `Provider`,
 * `Tool`, `McpCatalogEntry`, `SystemPromptEntry` y `PipelineActionEntry`
 * repiten idéntica, cada una con su propio `Map` estático. Cada clase sigue
 * siendo dueña de SU índice (`private static readonly catalog = new
 * Catalog(...)`) — esto no es una registry compartida entre entidades, sólo
 * saca el boilerplate repetido. La validación específica de cada
 * `register()` (ref-a-ref de PipelineActionEntry) sigue viviendo en la
 * clase, ANTES de delegar acá.
 *
 * `Agent`/`Project`/`Repo` NO usan esto — son config real (v1 la persiste,
 * un humano la edita), así que se resuelven en vivo contra una fuente
 * inyectada (`Agent.setSource`/etc.) en cada llamada, nunca cacheadas acá.
 * `Provider`/`Tool`/`McpCatalogEntry`/`SystemPromptEntry`/
 * `PipelineActionEntry` sí califican para el catálogo en memoria: se
 * registran una vez al boot (instancias concretas, no filas de config que
 * un humano edita en caliente) y no necesitan releerse por evento.
 */
export class Catalog<T> {
  private readonly byId = new Map<string, T>()

  constructor(private readonly getId: (item: T) => string) {}

  register(item: T): void {
    this.byId.set(this.getId(item), item)
  }

  resolve(id: string): T | undefined {
    return this.byId.get(id)
  }

  list(): T[] {
    return [...this.byId.values()]
  }

  reset(): void {
    this.byId.clear()
  }
}
