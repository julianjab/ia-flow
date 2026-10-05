# @ia-flow/workspace

Ver `README.md` para el contrato de uso; esto es guía específica para trabajar en el código.

## Estructura

```
src/
├── WorkspaceManager.ts   port de @ia-flow/workspace — ciclo de vida, sin engine
├── layout.ts             nombres y paths (task-<n>, <base>/<repo>/.worktrees/<name>) — puro
├── shell.ts              ShellRunner (interfaz) + NodeShellRunner
├── logger.ts             WorkspaceLogger + noopLogger
├── actions/              lo que se enchufa a agent-engine
│   ├── WorkspaceSession.ts        worktree por corrida (clave: el evento + el carril `ctx.lane`)
│   ├── WorkspaceToolAction.ts     fs_* / bash_run como Action + workspaceAction()
│   └── CleanupWorkspaceAction.ts  paso cleanup_workspace
└── tests/
    ├── WorkspaceManager.test.ts   port 1:1 de los tests de ia-flow (StubShell, sin disco)
    ├── integration.test.ts        git REAL contra un repo bare local (NodeShellRunner)
    └── actions.test.ts
```

## Mantener el port cerca del original

`WorkspaceManager.ts` y `layout.ts` son un port: los cambios respecto de ia-flow están listados en
el encabezado de `WorkspaceManager.ts` y en el README. Un fix que también aplique a ia-flow se
lleva allá; un cambio sólo de acá se agrega a esa lista. `WorkspaceManager.test.ts` es el test de
ia-flow portado — si un cambio de comportamiento lo rompe, eso es una divergencia a documentar,
no un test a "arreglar".

## Antes de tocar código

```bash
bun run --filter @ia-flow/workspace typecheck
bun run --filter @ia-flow/workspace test
```
