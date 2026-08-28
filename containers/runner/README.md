# containers/runner — el engine headless

Flavor `runner` de `apps/server`: escanea un board de GitHub, despacha agentes
y **no expone API**. Su superficie HTTP es el webhook, `/health` y —si están
habilitados— el self-registro de gateways.

```bash
# desde la RAÍZ del repo
podman build -f containers/runner/Dockerfile -t ia-flow-runner .
podman run --rm -v ./runner.yaml:/app/config/runner.yaml:ro \
  -e GITHUB_TOKEN -e CLAUDE_CODE_OAUTH_TOKEN ia-flow-runner
```

`ENTRYPOINT` es el binario y `CMD` es el flavor, así que un deploy no versiona
ningún script de arranque. Para otro archivo de config: `CMD ["runner", "/ruta/otro.yaml"]`.

## Contrato de deploy

Esto es lo que la imagen necesita, y es todo. Sirve igual para un
`docker-compose.yml` (ver `deploys/*/`) que para un manifiesto de Kubernetes.

| | Qué | Dónde |
| --- | --- | --- |
| **Config** | `runner.yaml`, más `projects/` y `agents/` si existen | monta en `/app/config/` (k8s: **ConfigMap**) |
| **Secretos** | `GITHUB_TOKEN` **o** el PEM de una GitHub App, y `CLAUDE_CODE_OAUTH_TOKEN` (o `ANTHROPIC_API_KEY`) | env (k8s: **Secret** vía `envFrom`). El PEM va como archivo y su path se declara en `github.privateKeyPath` del YAML |
| **Estado** | `/state` — SQLite del execution log + secret del webhook generado | volumen. Ver "Estado" abajo |
| **Puerto** | `3001` | `POST /api/webhooks/github`, `GET /health` |
| **Probe** | `GET /health` → `{"ok":true,"flavor":"runner"}` | readiness y liveness |

### Config repartida en carpetas

Al lado del `runner.yaml` puede haber una carpeta por sección, y cada `.yaml`
de adentro se suma a lo que la sección declare inline. Sin carpetas, no pasa
nada.

```
config/
  runner.yaml                    settings, github, upstream, mcp
  projects/
    la-haus-116/
      project.yaml               la definición del proyecto (o <id>.yaml)
      agents/10-refiner.yaml
      agents/20-implementer.yaml
      repos/backend.yaml
    otro-proyecto.yaml           un proyecto sin nada propio: archivo suelto
  agents/00-triage.yaml          agentes GLOBALES, aplican a todos los proyectos
```

**Se agrupa por proyecto, no por tipo de archivo.** Es la misma regla que el
repo pide para el código (`features/<dominio>/` en la web): lo que se toca
junto es "todo lo del proyecto X". Y tiene una consecuencia práctica — la
selección de agentes ya es por proyecto (`visibleTo`), así que la pregunta "¿en
qué orden quedan?" sólo tiene sentido dentro de uno.

**El nombre de la carpeta es el `projectId`**, así que no se repite en cada
archivo. Lo que el archivo declare igual gana: es un default, no una
imposición.

**Una carpeta dentro de `projects/` DEBE declarar su proyecto** en
`project.yaml` o `<id>.yaml`. Si no, el boot tira nombrando qué falta — sin ese
guard, agrupar archivos ahí los cargaría bajo un `projectId` que no existe, y
el síntoma sería un agente que no dispara nunca.

**Los globales van antes.** Un agente en `agents/` (sin `projectId`) aplica a
todos, y uno con el mismo `id` dentro de un proyecto lo pisa — es como se
especializa un agente para un proyecto sin duplicarlo entero.

**Poneles prefijo numérico.** Los archivos se leen en orden alfabético, y de
ese orden depende cuál agente gana cuando ninguno declara `position`
(`selectAgent` corre "el primero por `position`" y cae al orden de
declaración). Un archivo puede traer un objeto o una lista, como prefieras.

En el compose se monta una línea por carpeta usada:

```yaml
    volumes:
      - ./runner.yaml:/app/config/runner.yaml:ro
      - ./projects:/app/config/projects:ro
```

Sin esa segunda línea el contenedor ve un `runner.yaml` sin proyectos y **no
arranca** — el loader exige al menos uno, justamente para que un roster vacío
no parezca sano.

**Todo lo demás va en el `runner.yaml`.** No hay `IA_FLOW_*_REPO`, ni
`IA_FLOW_*_FILE`, ni `IA_FLOW_DAEMON_MODE`, ni las tres URLs de forward: el
bloque `settings` los vuelca al entorno al arrancar. La regla es **secreto →
env; comportamiento → el archivo**, y por eso el YAML se commitea.

## En Kubernetes

**`replicas: 1` y `strategy: Recreate`.** El runner es un daemon con estado:
escanea un board y despacha agentes. Dos réplicas son dos daemons mirando los
mismos issues, y cada uno despacharía su propio agente para la misma task — el
lock del orquestador es por proceso, no distribuido. Un `RollingUpdate` levanta
el pod nuevo antes de matar el viejo, así que produce lo mismo durante el
rollout.

**El secret del webhook va explícito en el Secret.** Cuando no viene por env,
`runner/webhook-secret.ts` genera uno y lo persiste en `/state` para sobrevivir
a un restart. Con un `emptyDir` eso no alcanza: cada pod nuevo genera uno
distinto, GitHub empieza a recibir 401 y desde afuera se ve como "el runner
dejó de reaccionar", sin un solo error en sus logs.

**`remoteProviders: false` en `settings`** salvo que de verdad haya un gateway
que se anuncie contra este pod. Con eso no queda **ningún** endpoint que mute
estado, y el ingress puede publicar el puerto entero sin una regla por path.
Con `true` (el default), `/api/provider-registrations` acepta escrituras sin
auth propia: el ingress tiene que rutear **sólo** `/api/webhooks/github`.

**`/state` con `emptyDir` es aceptable sólo si configurás `upstream`** — las
filas del execution log se reenvían al server principal y no se pierden en el
restart. Si no, va PVC y `StatefulSet`.

**`LOG_PLAIN=true`** ya viene en la imagen: NDJSON directo a stdout, sin el
worker de pino (que además no sobrevive al bundle). Lo recogen los logs del
pod.

**La imagen es `linux/amd64` fija**, porque los nodos lo son. Una imagen de la
arquitectura equivocada no falla al construirse ni al pushearse a ECR: falla en
el pod con `exec format error`, ya desplegada.

## Workspace: opt-in por deploy

`settings.workspace` en el `runner.yaml` decide si el flavor le inyecta un
provisioner a sus providers **sync**.

| | `false` (default) | `true` |
| --- | --- | --- |
| `prepareWorkspace` | plan vacío: cero clones, cero worktrees | clone en `/state/repos/<owner>/<repo>` + worktree por task |
| Cómo trabaja el roster | lee y escribe por el MCP de GitHub | además `fs_*` y `bash_run` sobre un checkout real |
| `/state` | unos KB (secret del webhook, execution log) | + el repo entero |

Prendelo donde el roster **escriba código**. El motivo no es el remoto: es que
`anthropic-api` corre dentro de este contenedor y es el **fallback** de
cualquier agente cuyo `provider` liste un `remote:*` — o sea, lo que corre
cuando ningún gateway acepta la tarea. Con el provisioner apagado ese camino
—el único garantizado— arranca con `fs_write`/`bash_run` cortando en el guard
de `writePaths` y un `## Git context` que le nombra un checkout inexistente,
mientras el mismo agente en un gateway trabaja normal. Prendiéndolo, los dos
caminos entregan el mismo terreno y un solo prompt sirve para ambos.

El `path` del catálogo de repos conviene que apunte a donde el provisioner va
a clonar (`/state/repos/<owner>/<repo>`): si no coincide, el run avisa con un
warn y clona por coordenadas igual, pero el warn se repite en cada dispatch
porque el catálogo YAML es read-only.

## Toolchain de validación: sólo Python

La imagen trae `uv` (pinneado) y un CPython 3.12 administrado por él. No es
para correr el engine —que es un binario de Bun— sino para que el agente que
corre acá adentro pueda **re-ejecutar el lint y los tests del repo que tocó**.

Sin eso, un roster con `settings.workspace: true` clona el repo, escribe el
diff y no puede validar nada: el paso de validación no falla, devuelve "sin
verificar" y el veredicto termina apoyado en el CI de GitHub. Un quality gate
que no puede correr el gate no es un gate.

| | Dónde |
| --- | --- |
| `uv` + `uvx` | `/usr/local/bin` (copiados de `ghcr.io/astral-sh/uv`, versión pinneada) |
| CPython 3.12 | `/opt/uv-python`, prebajado en el build |
| Cache de wheels | `/state/cache/uv` — **en el volumen**, para que el `uv sync` de un run cueste segundos y no minutos |

`UV_PYTHON_PREFERENCE=only-managed`: el intérprete es el que uv administra, no
el que arrastre Debian, así que la versión que valida es la que el repo pide.

**Cuesta ~150 MB** (48 MB de `uv`/`uvx` + 103 MB del intérprete): la imagen
pasa de ~268 MB a ~419 MB. Es el precio de que el reviewer pueda dar un
veredicto propio en vez de repetir lo que dice el CI.

**Ojo con el reloj.** `bash_run` arranca en 60 s y su cap duro son 300 s. Un
`uv sync` en frío ronda los 30 s (con el cache caliente, menos) y una suite
grande puede acercarse a los 200 s: el agente tiene que pasar `timeout_ms`
explícito o los tests mueren por default y la salida parcial se lee como un
fallo del código. Los prompts del roster de `deploys/subscriptions-pipeline`
lo dicen; un roster nuevo que valide con tests tiene que decirlo también.

**Sólo Python, a propósito.** Es el stack de los repos que hoy escriben los
rosters de este repo. Flutter, Ruby, Terraform y yarn NO están, y el reviewer
los reporta "sin verificar" — sumarlos convertiría la imagen del engine en una
imagen de CI, que se construye en minutos y se arrastra en cada deploy que no
los usa. El día que un roster valide Ruby, la pregunta correcta es si eso
corre en un gateway (`containers/gateway/`, que ya es "la máquina que tiene
las herramientas") antes que acá.

## Qué NO trae la imagen, y por qué

- **El CLI `claude`** — `claude-print` vive en el gateway
  (`containers/gateway/`); acá corre el loop de tools del engine.
- **Todo toolchain que no sea Python** — ver arriba.
- **`node_modules`** — `bun build` empaqueta el grafo entero en un archivo.
- **Un `entrypoint.sh`** — no hay dos procesos que coordinar.
