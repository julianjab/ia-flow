# packages/github-auth — Credenciales de GitHub

**Source-only** (sin build). Implementa el contrato `ICredentialProvider` de `@ia-flow/shared`
para GitHub, en tres estrategias intercambiables.

## Por qué es un paquete propio (y no vive en `issue-sources`)

La pregunta natural es "la auth de GitHub es del source de GitHub, ¿no?". No: **el token de
GitHub tiene un consumidor que no es un issue source**. `WorkspaceManager` (`@ia-flow/workspace`)
lo usa para clonar y pushear — eso es git, no tracking de issues. Y `apps/ai-provider-gateway`
lo necesita para lo mismo sin depender de `issue-sources` para nada más.

Ponerlo en `issue-sources` significaría:

1. La arista `workspace → issue-sources`: un paquete de worktrees dependiendo de uno que habla
   GraphQL de Projects V2.
2. El gateway tragándose `issue-sources` entero para conseguir un string con el que hacer
   `git clone`.

La asimetría real: **GitHub es tres cosas a la vez** — issue source, remote de git y servidor
MCP. Linear, cuando llegue, va a ser *sólo* un issue source y su auth va a vivir adentro de
`issue-sources`. Slack ya tiene su token en `packages/tools/src/slack/client.ts`, que es donde
está su cliente. No es inconsistencia: es que son cosas distintas.

Misma justificación textual que el CLAUDE.md raíz da para `@ia-flow/workspace`: *"lo consumen
dos apps que no comparten nada más"*.

## Las tres estrategias

| Modo | Identidad | Renovación | Para qué |
| --- | --- | --- | --- |
| `static` | PAT (una persona o machine user) | ninguna | fallback, CI, tests |
| `gh-cli` | tu usuario, vía `gh auth token` | la hace `gh` | dev local sin configurar nada |
| `github-app` | `<app>[bot]` | JWT → installation token, cada ~55' | el daemon desatendido |

`auto` (default) prueba **app → gh → PAT** y se queda con la primera *configurada*. El orden va
de la identidad más específica y duradera a la más genérica: quien se tomó el trabajo de
configurar una App quiere que el daemon corra como el bot, no como él. La estrategia que gana se
loguea al boot y sale en `describe()` — una cadena silenciosa deja sin respuesta la pregunta
"¿con qué identidad se escribió este comentario?".

## Reglas

- **El token se resuelve por uso, nunca se captura.** Es la razón de ser del paquete: un
  installation token vive una hora y el daemon vive días. Cualquier consumidor nuevo recibe el
  `ICredentialProvider` (o un `() => Promise<string|undefined>`), jamás un `string`.
- **Nadie instancia estas clases fuera de un composition root.** `apps/server/src/composition/container.ts`
  y `apps/ai-provider-gateway/src/providers.ts` son los dos únicos lugares.
- **`getToken()` devolviendo `undefined` no es un error** — un repo público clona sin credencial.
  El caller decide si eso lo bloquea.
- **Fail-open al elegir, fail-loud al pedir.** En `auto`, una estrategia que no se puede usar
  —`gh` sin sesión, un PEM ilegible— es sólo la señal de pasar a la siguiente. En un modo
  explícito (`mode: github-app`) la misma config rota **tira**: el operador pidió esa estrategia
  y sólo esa, y degradar en silencio lo dejaría preguntándose por qué el daemon actúa como
  anónimo.
- **Un fallo de construcción no se cachea.** `lazyGitHubCredentials` descarta la promesa
  rechazada, así que corregir el secreto desde Settings sana el proceso sin reiniciarlo. Sin eso,
  el diseño perezoso —que existe justamente para leer la config tarde— no serviría de nada.
- **Config nueva → variable en `ENV_VAR_DEFINITIONS`** (`apps/server/src/routes/env-vars.ts`),
  para que sea editable desde Settings y no sólo por `.env`.

## Setup de la GitHub App

1. Org → Settings → Developer settings → **New GitHub App**.
2. Permisos: `Contents: read/write`, `Issues: read/write`, `Pull requests: read/write`,
   `Metadata: read` y **`Organization projects: read/write`** — este último es el que se olvida
   y sin él Projects V2 no responde.
3. Instalarla en la org y elegir los repos.
4. Generar la private key (`.pem`) y anotar el App ID.
5. Settings de ia-flow (o `.env`): `IA_FLOW_GITHUB_AUTH_MODE=github-app`,
   `IA_FLOW_GITHUB_APP_ID`, `IA_FLOW_GITHUB_APP_PRIVATE_KEY` (PEM crudo o base64) —
   o `IA_FLOW_GITHUB_APP_PRIVATE_KEY_PATH`.

**Ojo con los Projects de usuario.** Un Project que cuelga de `users/<vos>/projects/N` no lo
cubre el permiso `Organization projects`. Si el Project es personal, hay que moverlo a la org
antes de que este modo sirva de algo.

**La atribución cambia** a `<app>[bot]`: commits, comentarios y PRs. Es lo que se busca, pero
rompe cualquier filtro que asuma un username humano, y una branch protection que exija review
de una persona no se satisface con la app.

## Comandos

```bash
bun run test
bun run typecheck
```
