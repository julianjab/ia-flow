# containers/ — las imágenes OCI de ia-flow

Un subdirectorio por imagen, cada uno con su `Dockerfile` y su
`Dockerfile.dockerignore`. `podman` y `docker` sirven las dos; nada acá asume
uno de los dos runtimes, y por eso la carpeta no se llama `docker/`.

| Imagen | Qué corre | Cuándo la querés |
| --- | --- | --- |
| `runner/` | `apps/server`, flavor `runner` | el engine headless: escanea un board, despacha agentes, no expone API. Su config es un `runner.yaml` bind-monteado |
| `gateway/` | `apps/ai-provider-gateway` | ejecutar agentes en la máquina que tiene las credenciales, el CLI `claude` o el filesystem — registrada contra un server/runner por HTTP |

## Por qué no viven junto a su app

**Todas se construyen con la raíz del repo como contexto**, porque necesitan el
workspace de Bun completo (los `packages/*` son `workspace:*`, no publicados).
Un `Dockerfile` dentro de `apps/x/` que sólo se puede construir desde dos
niveles más arriba miente sobre dónde pertenece:

```bash
# desde la raíz del repo, siempre
podman build -f containers/gateway/Dockerfile -t ia-flow-gateway .
```

Juntarlas además hace visible de un vistazo qué se despliega — que era
imposible cuando cada `Dockerfile` estaba escondido en la carpeta de su app.

## Imágenes vs. deploys

Acá va **cómo se construye** una imagen. **Con qué config se corre** vive en
`deploys/`: cada subcarpeta de ahí es una instancia (su `docker-compose.yml`,
su YAML de agentes, su `.env`) y varias pueden compartir la misma imagen. Una
imagen no conoce ningún proyecto de GitHub; un deploy no construye nada que no
esté acá.

## La regla que comparten las dos: bundle, sin `node_modules`

Las dos imágenes se construyen igual — un stage de build que hace `bun build`
sobre el entrypoint, y un stage de runtime que copia **un solo archivo** y nada
más. Ninguna instala dependencias en la imagen final.

```
FROM oven/bun:1 AS build      COPY . .  →  bun install  →  bun build --target=bun
FROM oven/bun:1-slim          COPY --from=build /app/<app>.js   ← y nada al lado
```

**Por qué no enumerar paquetes.** El gateway lo hacía: copiaba manifest por
manifest y corría `bun install` en la imagen final. Esa lista se desincronizó
sola — cuando apareció `packages/github-auth` nadie la actualizó y el build
empezó a morir con `@ia-flow/github-auth@workspace:* failed to resolve`. Una
lista a mano que hay que mantener sincronizada con el grafo de imports real es
una lista que se desincroniza. `bun build` sigue ese grafo solo: agregar una
dependencia nueva no toca ningún `Dockerfile`.

**La consecuencia que hay que tener presente al escribir código.** Sin
`node_modules` en runtime, cualquier cosa que resuelva un módulo **por nombre y
en runtime** no existe. El caso concreto y ya pagado son los targets de
`pino.transport`: se resuelven dentro de un worker thread, que muere al no
encontrarlos, y `thread-stream` lo reintenta por cada línea — un loop de
`{"err":{"message":"the worker has exited"}}` hasta que el cgroup mata al
contenedor con `Exited (137)`. El síntoma no nombra al módulo faltante en
ningún lado.

Por eso los dos loggers arman sus sinks **in-process**, importando
`pino-pretty` y `pino-roll` como módulos para que entren en el bundle. Ver
`apps/server/src/logger-sinks.ts` (tiene el detalle completo) y el bloque de
sinks de `apps/ai-provider-gateway/src/logger.ts`.

Lo mismo vale para `import.meta.dir` / `import.meta.url`: con `--compile`
apuntan adentro del ejecutable. Los dos usos que quedaban aceptan hoy un
override por env (`IA_FLOW_TASKS_ROOT`, `IA_FLOW_HOOK_SCRIPT_PATH`).

**`LOG_PLAIN=true` lo ponen las dos imágenes**: NDJSON crudo a stdout, que es
lo que un runtime de contenedores sabe juntar. Los colores de `pino-pretty`
serían basura adentro de `docker logs` o de un collector.

## Levantarlas

Ninguna imagen se corre a mano en el uso normal: cada carpeta de `deploys/`
trae su `docker-compose.yml` que la construye y la configura.

| Deploy | Imagen | Qué es |
| --- | --- | --- |
| `deploys/gateway/` | gateway | el gateway en contenedor, para cuando no puede vivir en tu host |

**Hoy no queda ningún deploy del runner en este repo.** Los que había migraron
a `claw-agents` (`agents/ai-development-flow/`), que construye su imagen desde
el **bundle publicado** —un `ADD` de `ia-flow-runner.js` verificado contra
`SHA256SUMS`— en vez de desde el working tree, y hornea el roster adentro para
que el digest identifique binario y prompts juntos.

`containers/runner/` sigue acá porque cubre el otro caso de uso: correr el
runner en contenedor desde un **commit sin publicar**. Ver la tabla de la
última sección.

```bash
cd deploys/<el-que-sea>
cp *.env.example .env          # completar los valores reales
podman compose up -d --build   # o: docker compose up -d --build
podman compose logs -f
```

**El runner está pinneado a `linux/amd64`** (los nodos del cluster son amd64).
En una Mac arm64 eso construye por emulación y tarda varios minutos; es
esperado, no un cuelgue. El gateway no está pinneado y construye nativo.

## Estas imágenes NO son lo que se publica

Lo que sale en cada release es el **bundle** (`ia-flow-server.js` y sus dos
hermanos, ~2 MB), no una imagen. Los `Dockerfile` de esta carpeta construyen
**desde el árbol de trabajo**, que es un caso de uso distinto y sigue siendo el
que usan los `deploys/`:

| | `containers/*/Dockerfile` | el artefacto de la release |
| --- | --- | --- |
| De dónde sale el código | del working tree (`COPY . .` + `bun build`) | de una release ya publicada |
| Para qué | correr un commit sin publicar | consumirlo desde OTRO repo (es lo que hace `claw-agents`) |
| Quién elige la imagen base | nosotros | vos |

**Por qué se publica el bundle y no la imagen:** una imagen le impone al
consumidor la base que elegimos nosotros —nuestra Debian, nuestros paquetes,
nuestro usuario, nuestro ciclo de parches—. Un bundle se referencia con un
`ADD` desde el Dockerfile de quien lo usa, sobre la base que ya tenga:

```dockerfile
FROM oven/bun:1.1.30-slim
ADD --chmod=644 https://github.com/julianjab/ia-flow/releases/download/vX.Y.Z/ia-flow-server.js /app/server.js
ENTRYPOINT ["bun", "run", "/app/server.js"]
```

`--chmod=644` no es cosmético: `ADD <url>` baja el archivo como
`-rw------- root root`, así que cualquier imagen con un `USER` no-root moriría
con "permission denied" sin que el error mencione al `ADD`.

Cada `.tar.gz` de la release trae ese mismo bundle más un `Dockerfile.example`
completo (git, `/state`, non-root) y un README. Se generan con
`bun run package:release <version>` — ver `scripts/package-release.ts`, que es
también donde vive el pin de Bun que viaja adentro de cada artefacto.

**El bundle necesita Bun**, no es un binario: lo que NO necesita es
`node_modules`, ni el repo, ni un `bun install`.
