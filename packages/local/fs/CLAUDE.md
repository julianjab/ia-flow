# @ia-flow/fs-tools

Ver `README.md` para el contrato de uso; esto es guía específica para trabajar en el código.

## Estructura

```
src/
├── shared.ts               resolveSafePath() + SKIPPED_DIR_NAMES (funciones puras)
├── FsTool.ts                clase base abstracta — this.baseDir, this.resolveSafePath()
├── tools/
│   ├── FsReadTool.ts, FsListTool.ts, FsGrepTool.ts, FsWriteTool.ts, FsEditTool.ts
│   ├── index.ts              barrel — re-exporta las 5 clases (API pública, no dispara registro)
│   └── tests/                un .test.ts por tool
├── FsToolRegistry.ts         extiende ToolRegistry<[string]> de agent-engine + registra las 5
├── index.ts
└── tests/                    shared.test.ts, FsToolRegistry.test.ts, index.test.ts
```

Mismo patrón que `@ia-flow/github-tools`: una tool por archivo, cada una una CLASE que extiende
`FsTool<S>` (que a su vez extiende `SchemaTool<S>` de `agent-engine`; constructor recibe
`baseDir: string`, hereda `this.resolveSafePath(...)`), y
`FsToolRegistry` extiende `ToolRegistry<[string]>` de `@ia-flow/agent-engine` — la lógica de
`get()`/`names()`/`all()`/`resolve()` vive ahí, compartida con `github-tools`. El registro de las
5 clases está centralizado en `FsToolRegistry.ts` (`FsToolRegistry.register(FsReadTool)`, etc.),
no repartido en cada archivo de tool — ver la nota completa en el `CLAUDE.md` de `github-tools`
("Por qué el registro no vive en cada tool file"), el motivo (un ciclo ESM/TDZ) es idéntico acá.
Ninguna de las dos tiene un `Client` de por medio — `node:fs/promises` alcanza — así que no hay
una versión "sin agent-engine" separada como `github-api`; este paquete ya depende de
`agent-engine` directo (necesita `Tool`/`ToolRegistry`).

## Agregar una tool nueva

1. Un archivo nuevo en `src/tools/`, con una clase `class MiTool extends FsTool<typeof MiToolInput> {
   readonly name = '...'; readonly description = '...'; readonly input = MiToolInput;
   protected async execute(input: MiToolInput) { ... } }`. El input se declara UNA vez como
   `export const MiToolInput = z.strictObject({...})` + `export type MiToolInput =
   z.infer<typeof MiToolInput>` — de ahí salen el `inputSchema` que ve el modelo y la
   validación en runtime (`SchemaTool` de `agent-engine`); nunca escribas `inputSchema` a mano.
   Siempre `strictObject`: el tipo de `SchemaTool` no acepta otro.
2. Sumala a `src/tools/index.ts` (el barrel).
3. En `FsToolRegistry.ts`: importala del barrel y agregá `FsToolRegistry.register(MiTool);` al
   final del archivo.
4. Sumala a los exports de `src/index.ts`.
5. Un `describe()` en `src/tools/tests/MiTool.test.ts`, con un `baseDir` real (`mkdtemp`) —
   incluí un caso de input inválido que verifique que no se tocó el disco.

## `resolveSafePath` — el único punto de entrada al filesystem

Ninguna tool llama `readFile`/`writeFile`/`readdir` con un path crudo del modelo. Todas pasan
primero por `resolveSafePath(baseDir, relativePath)`, que:
- rechaza un path absoluto (`isAbsolute`)
- resuelve contra `baseDir` y verifica que el resultado siga adentro (`relative()` no puede
  empezar con `..`)

Si agregás una tool nueva que toca el filesystem, pasa por acá — no reinventes la validación.

## `fs_grep` sin dependencias

No usa `ripgrep`/`grep` de sistema ni ningún paquete de glob — camina el árbol a mano con
`readdir(..., { withFileTypes: true })`, saltando `SKIPPED_DIR_NAMES`, con dos topes duros
(`MAX_MATCHES`, `MAX_FILES_SCANNED`) para que un patrón amplio en un repo grande no cuelgue el
run. Un archivo que no se puede leer como UTF-8 (binario) se salta, no aborta el grep entero.

## Tests — con directorios temporales reales, no mocks de `fs`

A diferencia de `github-tools` (que mockea `fetchImpl`), acá cada test crea un `baseDir` real
con `mkdtemp(join(tmpdir(), ...))` en un `beforeEach` y lo borra en `afterEach` — mockear
`node:fs/promises` no vale la pena para operaciones tan simples, y probar contra el filesystem
real es la única forma de verificar `resolveSafePath` de punta a punta (una tool que "cree" que
escapó el baseDir pero en realidad no puede tocar nada real).

## Antes de tocar código

```bash
bun run --filter @ia-flow/fs-tools typecheck
bun run --filter @ia-flow/fs-tools test
```

Source-only: sin build ni `dist/` — los `exports` apuntan a `src/*.ts` y los consumidores lo leen directo.
