# @ia-flow/fs-tools

`Tool[]` de [`@ia-flow/agent-engine`](../../agent-engine/core) para que un agente lea, liste,
busque, escriba y edite archivos — contenidas SIEMPRE a un `baseDir` (típicamente un worktree).
Réplica acotada de `fs_read`/`fs_list`/`fs_grep`/`fs_write`/`fs_edit` del roster real de
`ai-development-flow` (ver `examples/apps/ai-development-flow-runner.ts`, en el repo ia-tools — no migrado).

## Instalar (dentro del monorepo)

```bash
bun run --filter @ia-flow/fs-tools test
```

## Uso

```ts
import { Agent } from '@ia-flow/agent-engine';
import { FsToolRegistry } from '@ia-flow/fs-tools';

const fsTools = new FsToolRegistry('/path/al/worktree');

const implementer = new Agent({
  id: 'implementer',
  provider: 'anthropic-api',
  prompt: '...',
  tools: fsTools.all(), // o por nombre: fsTools.resolve(['fs_read', 'fs_grep', 'fs_write'])
  exits: { done: 'done' },
});
```

## Las cinco tools

| Tool | Qué hace |
| --- | --- |
| `fs_read` | Lee un archivo de texto completo (trunca a 256KB); con `focus`, de uno grande sólo lo pedido |
| `fs_list` | Lista archivos/carpetas de un directorio (no recursivo) |
| `fs_grep` | Busca un regex recursivamente, salta `node_modules`/`.git`/`dist`/`.turbo`/`.cache` |
| `fs_write` | Crea o sobreescribe un archivo completo, creando directorios padre si hace falta |
| `fs_edit` | Reemplaza `oldString` → `newString`; tira si no es única (salvo `replaceAll: true`) |

Cada tool también se exporta suelta, por si una app quiere una sola sin pasar por el registry:
`new FsReadTool('/path/al/worktree')`.

## `focus` — leer sólo lo que hace falta de un archivo grande

`fs_read` acepta `focus` ("la firma de createOrder y sus validaciones"). Si el archivo supera
15 000 caracteres, lo manda numerado (hasta 150 000) a quien cumpla la capacidad `FILE_FOCUS`
(`fileFocus`) y devuelve sólo esas partes, citadas con su rango de líneas. Quién enfoca se inyecta:
`new FsReadTool(dir, { focus })`, con `capabilityFocuser(ctx.capabilities)` para usar el `Runnable`
que la app enchufó en el engine (`@ia-flow/workspace` ya lo hace). Sin quién enfoque, o si falla,
`focus` se ignora y va el archivo (con el motivo, si falló).

## Seguridad — todo path es relativo y contenido a `baseDir`

Un `path` de una de estas tools es input del modelo, nunca confiable tal cual: `resolveSafePath`
(en `shared.ts`) rechaza cualquier path absoluto, que resuelva fuera de `baseDir` (traversal vía
`../..`), que pase por un symlink que escape de `baseDir` (roto o no), o que atraviese un
segmento `.git` — escribir ahí (`.git/config` con `core.pager`, `.git/hooks/*`) compromete
cualquier `git` que corra después vía `@ia-flow/shell-tools`, así que se rechaza siempre, exista
o no el directorio `.git` en ese punto. El chequeo de `.git` es case-insensitive (`.GIT` resuelve
al mismo directorio en macOS/Windows) y corre DOS veces — sobre el texto de entrada, y de nuevo
sobre el path ya resuelto tras seguir symlinks (`ln -s .git g` no tiene ".git" como segmento en
el texto que manda el modelo, sólo aparece después de resolver el link). Mismo criterio que
`issuePath` en `@ia-flow/github-tools` para `owner`/`repo`/`number`: los inputs de una tool son
controlados por el modelo, nunca se confían tal cual.

`fs_read`/`fs_grep` rechazan cualquier entrada que no sea un archivo regular (`stat().isFile()`)
antes de leerla — un FIFO (`mkfifo`, armable vía `@ia-flow/shell-tools`) hace que `readFile` se
quede esperando para siempre a que algo lo abra en escritura, y ningún timeout de `fs_grep` corta
eso una vez que ya arrancó.

**Esto no cubre todo el filesystem.** `fs-tools` es UN camino hacia los archivos — `bash_run`
(`@ia-flow/shell-tools`) es otro, completamente aparte, y esa policy tiene sus propios chequeos
para no escribir en `.git` vía `cp`/`mv`/`ln` (ver su README). Las dos capas se complementan; ni
una sustituye a la otra, y ninguna de las dos se declara una lista cerrada de bypasses conocidos.

## Qué NO es este paquete

No ejecuta comandos (`bash_run` vive en `@ia-flow/shell-tools`), no tiene memoria persistente
entre corridas (`memory_*` — no existe todavía en el engine de ia-flow) y no sabe nada de git ni de GitHub.
Es sólo el filesystem, contenido a un directorio.
