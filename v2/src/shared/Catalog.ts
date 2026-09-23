/**
 * `Map<string, T> + register/resolve/list/reset` — la forma que `Agent`,
 * `Project`, `Provider`, `Tool`, `McpCatalogEntry`, `SystemPromptEntry` y
 * `PipelineActionEntry` repetían idéntica, cada una con su propio `Map`
 * estático. Cada clase sigue siendo dueña de SU índice (`private static
 * readonly catalog = new Catalog(...)`) — esto no es una registry
 * compartida entre entidades, sólo saca el boilerplate repetido. La
 * validación específica de cada `register()` (exits de Agent, ref-a-ref de
 * PipelineActionEntry) sigue viviendo en la clase, ANTES de delegar acá.
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
