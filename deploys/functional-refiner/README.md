# Solo agente de refinación (modo polling)

Instancia de [`apps/agent-runner`](../../apps/agent-runner/README.md) (ver
ahí el mecanismo genérico: cómo se levanta, modo webhook/polling, auth,
logs, cambiar config sin rebuild). Esta carpeta solo tiene la config
puntual de este deploy: un solo agente de refinación, ya apuntado contra
`github.com/julianjab/ia-flow` (ver `projects.yaml`/`repos.yaml`), que
refina vía el **MCP oficial de GitHub** en vez de leer un checkout local —
el agente no tiene `fs_read`/`fs_list`/`fs_grep`, solo `update_issue_body` +
`mcpCatalogIds: [github-mcp]` (ver `agents.refiner.github-issues.yaml`,
`mcp-catalog.yaml`).

Corre en modo **polling** (`IA_FLOW_DAEMON_MODE=polling` en
`docker-compose.yml`) — no necesita túnel ni puerto público, hace pull
propio contra el issue source.

**Nota:** `projects.yaml`/`repos.yaml`/`mcp-catalog.yaml` ya tienen los
valores reales de este deploy puntual — no son placeholders. Si vas a
apuntar esta instancia a otro repo, reemplazá `owner`/`repo`/`anchorLabel`
en `projects.yaml`, `name`/`githubOwner`/`githubRepo`/`path` en `repos.yaml`
(el `path` sigue siendo obligatorio aunque el agente no lea el checkout
local — ver el comentario en `repos.yaml`).

### Variante: issues de un repo de GitHub directo (sin Project board)

[`agents.refiner.github-issues.yaml`](./agents.refiner.github-issues.yaml)
(la que usa este deploy, bind-monteada como `agents.yaml` en
`docker-compose.yml`) es para proyectos con source `kind: 'github-issues'`
(`packages/issue-sources/src/github-issues/`) — issues sueltos de UN repo,
sin pasar por un GitHub Project v2.

[`agents.refiner.yaml`](./agents.refiner.yaml) es la variante para Projects
v2 — para usarla, cambiá el bind-mount de `agents.yaml` en
`docker-compose.yml` y ajustá `projects.yaml`/`repos.yaml` al source real
(`kind: 'github-project'`).

Diferencia principal entre las dos: la variante `github-issues` no usa
`set_task_field` para resolver épica-vs-task por cardinalidad de repos — un
source `github-issues` está atado a un solo repo por diseño, así que
`task.repos` ya llega resuelto sin ambigüedad. `statusName`/`onFinish`/
`onError` funcionan igual en ambas (`ITaskSource.applyTransition` es
provider-agnostic), solo que en la variante `github-issues` mueven la label
`status:<nombre>` del issue en vez de un campo del board.

Antes de correr esto contra un repo real, creá las labels
`status:refine`/`status:refined`/`status:blocked` (o los nombres que uses) y
la label ancla (`anchorLabel`) en los issues que querés que el engine tome.

## Run

```bash
cd deploys/functional-refiner
cp refiner.env.example .env   # completar valores reales
docker compose up -d --build  # o: podman compose up -d --build
```

Mapea el contenedor a `127.0.0.1:3002` (no `3001`, para no chocar con el
server principal del host).
