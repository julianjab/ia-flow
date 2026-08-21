# agent-runner — engine headless genérico

Imagen mínima que corre solo `apps/server` (Hono API + daemon, sin la SPA
web) contra **cualquier** roster de agentes / proyecto / repo, sin conocer
de antemano cuáles — toda la config entra por 4 YAML bind-monteados en
runtime (`agents.yaml`, `projects.yaml`, `repos.yaml`, `mcp-catalog.yaml`).
La imagen nunca los trae baked-in, así que una sola build sirve para
cualquier instancia.

Hermano de [`apps/ai-provider-gateway`](../ai-provider-gateway/README.md):
ese es la app de **provider** (se registra contra el server principal como
un provider más, resolviendo internamente qué corre). Este es la app de
**runner** (corre un roster de agentes completo — refina, implementa,
revisa CI, lo que declares — contra un proyecto real). Juntas cubren los dos
roles que alguien externo al server principal puede tomar.

## Qué YAML hace falta

Solo 4 de los 8 repos dual-source del engine (ver
`apps/server/src/infrastructure/db/index.ts`, `pickRepo`/`resolveRepoSource`):
agentes, proyecto, repo, y catálogo MCP — cada uno vía su env var puntual
(`IA_FLOW_AGENT_REPO`/`IA_FLOW_PROJECT_REPO`/`IA_FLOW_REPOS_REPO`/
`IA_FLOW_MCP_CATALOG_REPO`), ya fijas en el `Dockerfile`. Los otros 4
(statuses, system prompts, settings, prompts) quedan en SQLite por default,
sin que ningún runner los toque — `statuses` en particular ya no hace falta
para nada: el engine dejó de filtrar el scan por esa tabla (ver
`TaskDispatcher.dispatch`/`selectAgent` en `packages/agent-engine`).

Ver [`examples/`](examples/) para un roster de un solo agente (implementa
código vía el MCP de GitHub, sin checkout local) que podés copiar y ajustar.
Para un pipeline de varios pasos (refine → build → review), agregá más
entradas a `agents.yaml` — una label `agent:<paso>` propia por agente, cada
uno con su `onProcess`/`onFinish`/`onError` (ver la sección "El pipeline en
detalle" de cualquier `runners/<instancia>/README.md` existente para el
patrón completo).

## Crear una instancia nueva

Las instancias reales (tus 4 YAML + tu `.env` con tokens) viven en
`runners/<nombre>/`, en la raíz del repo — esa carpeta está en `.gitignore`:
lo que corrés ahí es tuyo, no se versiona en `ia-flow`.

```bash
mkdir -p runners/mi-instancia
cd runners/mi-instancia

cp ../../apps/agent-runner/examples/agents.yaml .
cp ../../apps/agent-runner/examples/projects.yaml .
cp ../../apps/agent-runner/examples/repos.yaml .
cp ../../apps/agent-runner/examples/mcp-catalog.yaml .
# ajustá los 4 a tu repo/roster real

cp ../../apps/agent-runner/docker-compose.example.yml docker-compose.yml
# ajustá container_name / puertos / IA_FLOW_INSTANCE_ID (buscá "CAMBIAME")

cp ../../apps/agent-runner/.env.example .env
# completá CLAUDE_CODE_OAUTH_TOKEN (o ANTHROPIC_API_KEY) + GITHUB_TOKEN

docker compose up -d --build
# o: podman compose up -d --build
docker compose logs -f runner
```

## Modo webhook vs polling

`IA_FLOW_DAEMON_MODE` en tu `.env` (default: `webhook`, ver
`apps/server/CLAUDE.md`):

- **webhook** — `entrypoint.sh` arranca además un proxy standalone
  (`scripts/webhook-proxy.ts`) que solo reenvía `POST /api/webhooks/github`
  (404 a todo lo demás), en el puerto `IA_FLOW_PROXY_PORT` (default `8787`).
  Necesitás un túnel público corrido a mano en el host apuntando a ese
  puerto (`cloudflared tunnel --url http://localhost:<puerto-host>`, o
  ngrok) — el contenedor no abre ni administra ninguno. Al bootear, mirá los
  logs (`docker compose logs -f runner`) para el secret que hay que pegar en
  GitHub (Settings > Webhooks del repo).
- **polling** — el server hace polling propio contra el issue source, no
  necesita que nada le llegue por HTTP desde afuera. No hace falta túnel ni
  publicar ningún puerto.

## Auth

- `CLAUDE_CODE_OAUTH_TOKEN` (recomendado) o `ANTHROPIC_API_KEY` —
  `buildAnthropicAuthHeader` (`packages/ai-providers/src/anthropic-api/auth.ts`)
  prioriza el token OAuth sobre la API key si las dos están seteadas.
  Generalo con `claude setup-token`.
- `GITHUB_TOKEN` — Personal Access Token (classic o fine-grained) con
  permisos de escritura sobre el repo real: `contents` + `pull_requests` +
  `issues` como mínimo si tu roster escribe vía MCP de GitHub; ajustá según
  qué tools/MCP declares en tu `agents.yaml`.

## Logs hacia el server principal (opcional)

Para que los logs/ejecuciones de tu instancia aparezcan en el
`daemon.log`/UI del server principal que corre en tu host (`bun run start` /
`bun run dev:server`):

1. En el host, seteá un token antes de arrancarlo:
   `IA_FLOW_REMOTE_LOG_TOKEN=algo-random bun run start`
2. En tu `.env`, completá `IA_FLOW_REMOTE_LOG_URL` /
   `IA_FLOW_REMOTE_LOG_TOKEN` (mismo valor que el paso 1) y, para el tab
   "Ejecuciones", `IA_FLOW_REMOTE_EXECUTIONS_URL`.

`host.containers.internal`, no `host.docker.internal`: Podman (gvproxy) lo
resuelve de fábrica apuntando al host, sin `extra_hosts` — con Docker
Desktop, `host.docker.internal` funciona en su lugar (ahí sí hace falta
`extra_hosts: host.docker.internal:host-gateway`). Sin las dos vars, el
comportamiento es el de siempre: solo archivo local, sin forward.

## Cambiar la config sin rebuild

Los bind-mounts de `docker-compose.yml` ya apuntan a tus 4 YAML locales —
editalos y `docker compose restart runner` (no hace falta `--build`: la
imagen no cambió, solo los archivos montados).

## Notas Podman

Es un Dockerfile OCI estándar — `docker build`/`docker run` funcionan igual.
En macOS con Podman, arrancá la VM primero: `podman machine start`.
