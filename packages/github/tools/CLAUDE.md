# @ia-flow/github-tools

Puente entre `@ia-flow/github-api` y `@ia-flow/agent-engine`. Ver `README.md` para el
contrato de uso; esto es guía específica para trabajar en el código del paquete.

## Por qué este paquete y no uno de los otros

`@ia-flow/github-api` no puede definir `Tool[]` — no depende de `agent-engine` (es standalone
a propósito). `agent-engine` no puede saber hablar con la REST API de GitHub — es contrato
puro, sin I/O. Este paquete es el único punto que importa los dos: `GithubClient` (de
`github-api`) + el tipo `Tool` (de `agent-engine`). Vive en `packages/github/tools/` —
hermano de `auth/`, `webhook/` y `api/` dentro de la misma carpeta `github/`, pero como
`package.json` propio, no como subcarpeta de ninguno de los otros tres.

## Estructura

```
src/
├── shared.ts               GithubIssueApiShape, summarizeIssue(), issuePath() + validación
├── GithubTool.ts            clase base abstracta — this.client, this.issuePath(), this.summarizeIssue()
├── tools/
│   ├── GetIssueTool.ts, CommentIssueTool.ts, AddLabelsTool.ts, SearchIssuesTool.ts
│   ├── index.ts             barrel — re-exporta las 4 clases (API pública, no dispara registro)
│   └── tests/               un .test.ts por tool
├── GithubToolRegistry.ts    extiende ToolRegistry<[GithubClient]> de agent-engine + registra las 4
├── index.ts
└── tests/                   shared.test.ts, GithubToolRegistry.test.ts, index.test.ts
```

Una tool por archivo — cada una es una CLASE que extiende `GithubTool<S>` (que extiende `SchemaTool<S>`
de `agent-engine`; constructor recibe el `GithubClient`, hereda `this.issuePath()`/`this.summarizeIssue()`), no una función factory.
`GithubToolRegistry` extiende `ToolRegistry<[GithubClient]>` de `@ia-flow/agent-engine` — la
lógica de `get()`/`names()`/`all()`/`resolve()` y de instanciar-todo-lo-registrado vive ahí, una
sola vez, compartida con `@ia-flow/fs-tools` y cualquier otro dominio de tools futuro.

## Agregar una tool nueva

1. Un archivo nuevo en `src/tools/`, con una clase `class MiTool extends GithubTool<typeof MiToolInput> {
   readonly name = '...'; readonly description = '...'; readonly input = MiToolInput;
   protected async execute(input: MiToolInput) { ... } }`. El input se declara UNA vez como
   `export const MiToolInput = z.strictObject({...})` + `export type MiToolInput =
   z.infer<typeof MiToolInput>` — de ahí salen el `inputSchema` que ve el modelo y la
   validación en runtime (`SchemaTool` de `agent-engine`); nunca escribas `inputSchema` a mano.
   Siempre `strictObject`: el tipo de `SchemaTool` no acepta otro.
2. Sumala a `src/tools/index.ts` (el barrel — export type + export de la clase).
3. En `GithubToolRegistry.ts`: importala del barrel y agregá una línea
   `GithubToolRegistry.register(MiTool);` al final del archivo — **no** hagas que la tool se
   auto-registre importando `GithubToolRegistry` desde su propio archivo (ver la nota de abajo,
   "Por qué el registro no vive en cada tool file").
4. Sumala a los exports de `src/index.ts` (tipo + clase).
5. Un `describe()` en `src/tools/tests/<Nombre>Tool.test.ts`, instanciando la clase directo
   (`new MiTool(clientWith(fetchImpl))`) con un `fetchImpl` fake — nunca pega a la red real
   (mismo criterio que `provider-anthropic-api`/`github`).
6. Si el endpoint devuelve un shape que ya usa otra tool (ej. un issue), reusá
   `this.issuePath()`/`this.summarizeIssue()` (heredados de `GithubTool`) en vez de duplicar el
   parseo o la validación de `owner`/`repo`/`number` (estos son inputs controlados por el
   modelo — sin `issuePath()` un `repo: "../../orgs/other-org/repos"` se escapa del endpoint
   esperado).

## Por qué el registro no vive en cada tool file

La forma "más auto" sería que cada tool se auto-registrara al final de su propio archivo
(`GithubToolRegistry.register(MiTool)` DENTRO de `MiTool.ts`) — se probó y se descartó: crea una
dependencia circular real con `GithubToolRegistry.ts` (que a su vez necesita importar los
archivos de tools para dispararlas). En ESM un ciclo así cae en TDZ — cuando el archivo de la
tool, importado a mitad de la evaluación de `GithubToolRegistry.ts`, intenta usar
`GithubToolRegistry`, la clase todavía no terminó de inicializarse en ese módulo. Centralizar
el `.register(...)` en `GithubToolRegistry.ts` (una línea por tool, después de la declaración de
la clase) evita el ciclo sin perder el resto: nadie mantiene a mano el array de INSTANCIAS ni la
lógica de construcción — eso lo hace `ToolRegistry` (agent-engine) automáticamente a partir de
las clases registradas.

## Contrato de errores — coincide con `AnthropicProvider`

Un `handler` que tira (`GithubClient.requestJson` ya tira con el status + body en un 4xx/5xx) NO
se atrapa acá — `AnthropicProvider.run` (en `provider-anthropic-api`) envuelve cada `tool.handler` en
su propio try/catch y lo convierte en un `tool_result` con `is_error: true`. Agregar un
try/catch acá sería redundante y escondería el mensaje de error real detrás de uno genérico.

## Antes de tocar código

```bash
bun run --filter @ia-flow/github-tools typecheck
bun run --filter @ia-flow/github-tools test
```

Source-only: sin build ni `dist/` — los `exports` apuntan a `src/*.ts` y los consumidores lo leen directo.
