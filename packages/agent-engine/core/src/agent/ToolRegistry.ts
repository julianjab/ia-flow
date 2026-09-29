import type { Tool } from './AgentDefinition.js'

export type ToolConstructor<TArgs extends unknown[]> = new (...args: TArgs) => Tool

/**
 * Base genérica para un registry de `Tool` que se AUTO-REGISTRAN por clase — cada dominio
 * concreto (`@ia-flow/github-tools`, `@ia-flow/fs-tools`, ...) extiende esto con SU PROPIO
 * `TArgs` (lo que el constructor de sus tools necesita: un `GithubClient`, un `baseDir`, lo que
 * sea) en vez de mantener a mano un array de instancias en el constructor del registry.
 *
 * El patrón, de punta a punta (ver `@ia-flow/github-tools`/`@ia-flow/fs-tools` para el caso
 * real):
 *   1. Un dominio declara `class FooRegistry extends ToolRegistry<[FooClient]> {
 *        protected static registeredTools: ToolConstructor<[FooClient]>[] = [];
 *      }` — la redeclaración del `static` es OBLIGATORIA (ver la nota de abajo), no boilerplate
 *      cosmético.
 *   2. Cada tool concreta (`class GetIssueTool extends BaseFooTool<Input> { ... }`) vive en su
 *      propio archivo, SIN llamar `register` — ver la nota "Por qué el registro está
 *      centralizado" más abajo.
 *   3. `FooRegistry.ts` importa las clases de tools y llama `FooRegistry.register(GetIssueTool)`
 *      una vez por tool, DESPUÉS de la declaración de `class FooRegistry` — todas esas llamadas
 *      viven en el mismo archivo que la clase.
 *   4. `new FooRegistry(client)` construye TODAS las tools registradas, indexadas por
 *      `tool.name`.
 *
 * Agregar una tool nueva es: crear el archivo con la clase, sumarla al barrel `tools/index.ts`,
 * y agregar UNA línea `FooRegistry.register(MiTool)` en `FooRegistry.ts` — nunca tocar la
 * lógica de construcción del registry (`ToolRegistry`, acá).
 *
 * ## Por qué el registro está centralizado en `FooRegistry.ts`, no repartido en cada tool file
 *
 * La forma más "auto" sería que cada tool se registrara sola, al final de su propio archivo
 * (`FooRegistry.register(MiTool)` DENTRO de `MiTool.ts`) — se probó y se descartó: crea una
 * dependencia circular real con `FooRegistry.ts` (que a su vez necesita importar los archivos
 * de tools para dispararlas). En ESM un ciclo así cae en TDZ — cuando el archivo de la tool,
 * importado a mitad de la evaluación de `FooRegistry.ts`, intenta usar `FooRegistry`, la clase
 * todavía no terminó de inicializarse en ese módulo. Centralizar el `.register(...)` en
 * `FooRegistry.ts` evita el ciclo sin perder el resto: nadie mantiene a mano el array de
 * INSTANCIAS ni la lógica de construcción — eso lo hace esta clase, automáticamente, a partir
 * de las clases registradas.
 *
 * ## Por qué el `static registeredTools` se redeclara en cada subclase
 *
 * TypeScript prohíbe que un `static` referencie el type parameter de la clase (`TArgs`), así
 * que la base sólo puede tipar su propio `registeredTools` como `ToolConstructor<any>[]`. Pero
 * el problema real es más profundo que el tipo: en JS, un `static` NO se "clona" por subclase
 * — es una propiedad propia de la función constructora de la clase que lo declara, y una
 * subclase que no lo redeclara la HEREDA por prototype chain, es decir, comparte la MISMA
 * array. Sin la redeclaración, `GithubToolRegistry` y `FsToolRegistry` (si ambas extendieran
 * esta base sin redeclarar `registeredTools`) empujarían a una única lista compartida — cada
 * tool de cada dominio terminaría "disponible" en el registry de cualquier otro dominio. La
 * redeclaración (`protected static registeredTools: ToolConstructor<[TusArgs]>[] = [];`) le da
 * a cada subclase su PROPIA propiedad, sombreando la de la base — y de paso, tipa
 * `TArgs` concreto para ese dominio.
 */
export abstract class ToolRegistry<TArgs extends unknown[]> {
  protected static registeredTools: ToolConstructor<any>[] = []

  /** Llamado por cada subclase concreta (`FooRegistry.register(SomeTool)`) — `this` es la
   *  subclase real en el punto de llamada, así que empuja al `registeredTools` REDECLARADO de
   *  esa subclase, nunca al de la base. */
  static register(ToolClass: ToolConstructor<any>): void {
    // biome-ignore lint/complexity/noThisInStatic: `this` acá es POLIMÓRFICO a propósito (la subclase real que llamó `.register`) — "usar el nombre de la clase" rompería el aislamiento entre dominios (ver el doc de la clase).
    this.registeredTools.push(ToolClass)
  }

  private readonly tools: Map<string, Tool>

  constructor(...args: TArgs) {
    const ctor = this.constructor as unknown as { registeredTools: ToolConstructor<TArgs>[] }
    this.tools = new Map(
      ctor.registeredTools.map((ToolClass) => {
        const instance = new ToolClass(...args)
        return [instance.name, instance] as const
      }),
    )
  }

  get(name: string): Tool {
    const tool = this.tools.get(name)
    if (!tool) {
      throw new Error(
        `${this.constructor.name}: no existe una tool "${name}" — disponibles: ${this.names().join(', ')}`,
      )
    }
    return tool
  }

  names(): string[] {
    return [...this.tools.keys()]
  }

  all(): Tool[] {
    return [...this.tools.values()]
  }

  resolve(names: string[]): Tool[] {
    return names.map((name) => this.get(name))
  }
}
