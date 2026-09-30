# ia-flow

Orquesta agentes de IA contra repos y GitHub Projects. Monorepo Bun: un runner headless
(`apps/runner-v2`) sobre los paquetes del engine, más una SPA Vue y su visor Electron.

Cada carpeta con código propio trae su `AGENTS.md` o `CLAUDE.md`: **el más cercano al archivo que
tocás manda** sobre este. Leelo antes de cambiar algo ahí.

## Dónde va cada cambio

| Querés… | Va en |
| --- | --- |
| Cambiar cómo corre un pipeline o un agente (ejecuciones, pausas, colas, salidas) | `packages/agent-engine/core` — contrato puro, sin I/O |
| Validar o armar definiciones (schemas de agentes y pipelines) | `packages/agent-engine/definitions` |
| Una tool o acción de GitHub para un agente | `packages/github/tools` |
| Hablar con GitHub (REST/GraphQL, auth, webhooks) | `packages/github/{api,auth,webhook}` |
| Slack, disco, shell, worktrees | `packages/slack/*`, `packages/local/*` |
| Un modelo o CLI nuevo como provider | `packages/providers/*` |
| El runner: servidor, intake, catálogo de acciones, bandeja, asistente | `apps/runner-v2/src` (ver su `AGENTS.md`) |
| Un prompt, un pipeline o un agente de un deploy | la config de ese deploy (`runner.yaml` + `projects/`), no el código |
| La web | `apps/web` — antes de tocar un `.vue` o `.css`, `apps/web/DESIGN_SYSTEM.md` |
| Un tipo que cruza el wire hacia la web | `packages/shared` (Zod) |

## Comandos (desde la raíz)

```bash
bun install
bun run check                      # biome + fronteras + typecheck + tests — obligatorio antes de push
bun run lint:boundaries            # sólo las fronteras (.dependency-cruiser.cjs)
bun run test:<pkg>                 # un paquete: test:agent-engine, test:github-tools, test:runner-v2…
bun run typecheck:<pkg>
bun run runner                     # runner-v2: carga y valida la config, sin servir
bun run runner:serve               # runner-v2: servidor de webhooks
bun run dev                        # la web (5173)
```

Un solo archivo de tests: `bun test --cwd apps/runner-v2 <archivo>` (runner) o
`bun run --cwd <paquete> test -- <archivo>` (vitest). Corré el de lo que tocaste antes que la suite.

## Invariantes

Las fronteras entre paquetes y carpetas NO se describen acá: las verifica `bun run lint:boundaries`
y cada regla dice cómo arreglarla. Lo que no se puede verificar:

- **Bun es el único package manager y Biome el único linter/formatter.** Nada de npm/pnpm/yarn,
  ESLint ni Prettier.
- **Los paquetes son source-only:** `exports` apunta a `src/index.ts`, sin build ni `dist/`. Un
  cambio de API se ve al instante en los consumidores: corré también su `typecheck`.
- **Se importa un paquete por su nombre (`@ia-flow/<paquete>`), nunca por ruta ni por `/src/…`.**
  Lo que falte, se exporta desde su `src/index.ts`.
- **Imports con extensión `.js`** (ESM, `NodeNext`). La web usa el alias `@/*`.
- **Nada de `utils/`, `helpers/`, `common/`:** el código va en el dominio que lo usa.
- **Nunca escribir estado dentro del repo.** El runner usa `IA_FLOW_HOME`
  (`~/.local/state/ia-flow/runner`); los tests, el tmp del sistema.
- **Bun lee `experimentalDecorators` del `tsconfig` del directorio desde el que corre**, no del de
  cada archivo: `@memoize` sólo funciona si Bun corre con `--cwd` del paquete. Los scripts ya lo
  hacen; no corras `bun test` desde la raíz apuntando a un archivo de otro paquete.
- **Logs con `createLogger('scope')`** de `@ia-flow/telemetry`, no `console.log`.
- **Nombres:** camelCase (TS), PascalCase (tipos, clases, componentes), SCREAMING_SNAKE_CASE (env),
  snake_case (payloads, columnas, ids de tools).

## Tests

- Paquetes: `src/**/tests/*.test.ts` (Vitest), nunca contra la red real (`fetchImpl` inyectable).
- `apps/runner-v2`: `<módulo>.test.ts` al lado del módulo (`bun test`); `src/tests/` sólo los de
  punta a punta.
- `apps/web`: `test/Foo.test.ts` junto al componente o módulo (Vitest).

## Commits y ramas

Conventional Commits. El código y sus tests van en commits separados (lo exige un hook). No se
mergea a `main` sin `bun run check` en verde.
