# @ia-flow/github-tools

`Tool[]` de [`@ia-flow/agent-engine`](../../agent-engine/core) respaldadas por la REST API de
GitHub — leer un issue, comentar, agregar labels, buscar issues. Es el ÚNICO puente entre
[`@ia-flow/github-api`](../api) (el client, no sabe qué es un `Agent`) y `agent-engine`
(el tipo `Tool`, no sabe hablar con GitHub) — ninguno de los dos se conoce entre sí.

## Instalar (dentro del monorepo)

```bash
bun run --filter @ia-flow/github-tools test
```

## Uso

```ts
import { Agent } from '@ia-flow/agent-engine';
import { GithubTokenAuth } from '@ia-flow/github-auth';
import { GithubClient } from '@ia-flow/github-api';
import { GithubToolRegistry } from '@ia-flow/github-tools';

const client = new GithubClient({ auth: new GithubTokenAuth(process.env.GITHUB_TOKEN!) });
const registry = new GithubToolRegistry(client);

const triage = new Agent({
  id: 'triage',
  provider: 'anthropic-api',
  prompt: 'Leé el issue #{{number}} de {{owner}}/{{repo}} y decidí si es un bug accionable.',
  tools: registry.all(), // las 4 — o elegí por nombre: registry.resolve(['github_get_issue', ...])
  exits: { actionable: 'actionable', 'not-actionable': 'not-actionable' },
});
```

### Acceso por nombre

`GithubToolRegistry` resuelve tools por string — útil cuando la lista de tools que un agente
puede usar viene de config (ej. un YAML de pipeline) en vez de estar hardcodeada en el código:

```ts
registry.names(); // ['github_get_issue', 'github_comment_issue', 'github_add_labels', 'github_search_issues']
registry.get('github_get_issue'); // Tool — tira con mensaje útil si el nombre no existe
registry.resolve(['github_get_issue', 'github_add_labels']); // Tool[] en el orden pedido
```

Cada tool (`GetIssueTool`, `CommentIssueTool`, `AddLabelsTool`, `SearchIssuesTool`) también se
exporta suelta, por si una app quiere una sola sin pasar por el registry: `new
GetIssueTool(client)`.

## Las cuatro tools

| Tool | Qué hace |
| --- | --- |
| `github_get_issue` | Lee título, cuerpo, estado y labels de un issue |
| `github_comment_issue` | Publica un comentario (issue o PR — la API los trata igual) |
| `github_add_labels` | Agrega labels a un issue (no reemplaza las existentes) |
| `github_search_issues` | Busca con la sintaxis de búsqueda de GitHub (`repo:o/r is:open label:bug`) |

Un error de la API (404, 401, rate limit) hace que un `handler` tire — `AnthropicProvider` ya
convierte eso en un `tool_result` con `is_error: true` en vez de tumbar el run entero (ver
`provider-anthropic-api`), así que las tools acá no necesitan su propio try/catch defensivo.

## Por qué es un paquete propio y no vive en `@ia-flow/github-api`

`@ia-flow/github-api` es standalone a propósito (cero dependencia de `agent-engine`, usable
por cualquier engine). El tipo `Tool` es vocabulario de `agent-engine`, así que envolver
`GithubClient` en `Tool[]` necesita conocer los dos — de ahí que sea un cuarto paquete, no que
uno de los otros importe al que le falta.
