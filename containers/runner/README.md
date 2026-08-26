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

## Qué NO trae la imagen, y por qué

- **`git`** — este flavor no inyecta provisioner de workspace, así que
  `AnthropicApiProvider.prepareWorkspace` devuelve un plan vacío: cero clones,
  cero worktrees. El roster lee y escribe por el MCP de GitHub. Un agente que
  necesite disco corre detrás de un gateway (`containers/gateway/`).
- **El CLI `claude`** — mismo motivo: `claude-print` vive en el gateway.
- **`node_modules`** — `bun build` empaqueta el grafo entero en un archivo.
- **Un `entrypoint.sh`** — no hay dos procesos que coordinar.
