import {
  AgentDefinitionSchema,
  McpCatalogEntrySchema,
  ProjectSchema,
  RepoDefSchema,
  RuleSchema,
} from '@ia-flow/shared'
// Contrato del `runner.yaml` — el ÚNICO archivo que un deploy del engine
// headless versiona.
//
// Vive en `apps/server/src/runner/` y NO en `packages/shared`: ese paquete es
// el contrato server↔web, y su propia regla dice que algo pertenece ahí si
// "al borrar apps/web el símbolo sigue teniendo sentido para el server **y
// viceversa**". La web no tiene nada que hacer con el formato de config de un
// deploy headless. Estuvo ahí un rato por inercia de dónde viven los otros
// schemas.
//
// Reemplaza a los cuatro YAML sueltos (agents/projects/repos/mcp-catalog) que
// existían porque son cuatro repositorios distintos del server, no porque un
// operador quiera cuatro archivos. Acá se declaran juntos, y el loader
// (apps/server/src/infrastructure/config/) los reparte a los mismos
// Yaml*Repository de siempre.
//
// La regla que ordena qué va acá y qué va al ambiente:
//
//   **secreto → env; comportamiento → este archivo.**
//
// Por eso `github.appId` vive acá (no es secreto) y el PEM no (se monta y se
// nombra por path). Y por eso `settings` puede existir: todos los knobs del
// dispatch se leen perezosamente de `process.env` en el momento de usarse
// (ver packages/issue-sources/src/dispatch/env.ts, que lo documenta), así que
// volcar este bloque al env antes de arrancar el daemon es suficiente — sin
// tocar una línea de esos paquetes.
import { z } from 'zod'

/**
 * Knobs del daemon. Todos opcionales: el default de cada uno vive en el
 * módulo que lo lee, NO acá — duplicarlo haría que el YAML y el código se
 * desincronicen sin que nada lo note.
 *
 * Cada campo mapea a una env var existente (ver SETTINGS_ENV en el loader).
 * Se declara con nombre propio en vez de un `env: {}` crudo para que un típo
 * sea un error de validación en el boot y no una variable ignorada en
 * silencio.
 */
export const RunnerSettingsSchema = z
  .object({
    /** `webhook` (default) o `polling`. → IA_FLOW_DAEMON_MODE */
    daemonMode: z.enum(['webhook', 'polling']).optional(),
    /** trace|debug|info|warn|error|fatal. → LOG_LEVEL */
    logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).optional(),
    /** Etiqueta de este deploy en los logs/ejecuciones. → IA_FLOW_INSTANCE_ID */
    instanceId: z.string().optional(),
    /** Puerto HTTP. En este flavor sirve un solo endpoint: el webhook. */
    port: z.number().int().positive().optional(),
    /** Agentes corriendo a la vez. → IA_FLOW_MAX_CONCURRENT_DISPATCHES */
    maxConcurrentDispatches: z.number().int().positive().optional(),
    /** Sólo modo polling. → IA_FLOW_POLL_INTERVAL_MS */
    pollIntervalMs: z.number().int().positive().optional(),
    /** Red de seguridad en modo webhook; 0 = apagada. → IA_FLOW_WEBHOOK_FALLBACK_MS */
    webhookFallbackMs: z.number().int().nonnegative().optional(),
    /** Escaneo al arrancar. → IA_FLOW_STARTUP_SCAN */
    startupScan: z.boolean().optional(),
    /** Recuperación de runs que quedaron abiertos. → IA_FLOW_CRASH_RECOVERY */
    crashRecovery: z.boolean().optional(),
    /**
     * Qué hacer ante un fallo no capturado. `survive` (default) cancela los
     * runs en vuelo y sigue vivo; `exit` cancela y además sale con código 1,
     * que es lo que quiere un deploy con `restart: unless-stopped`.
     * → IA_FLOW_FATAL_POLICY
     */
    fatalPolicy: z.enum(['survive', 'exit']).optional(),
    /**
     * Si este runner acepta que un agent-host se anuncie
     * (`POST /api/provider-registrations`) y sondea su salud. Default `true`:
     * es lo que hace alcanzable un `provider: remote:<name>`.
     *
     * Ponelo en `false` donde no haya agent-hosts —un deploy en Kubernetes, donde
     * el agent-host sería un proceso en la laptop de alguien— y el pod queda sin
     * un solo endpoint que mute estado: sólo el webhook y /health. Es la
     * diferencia entre necesitar una regla de ingress por path y no
     * necesitarla.
     *
     * Único knob de `settings` que NO mapea a una env var: lo lee el flavor
     * directo de la config.
     */
    remoteProviders: z.boolean().optional(),
    /**
     * Si este runner le inyecta un provisioner de workspace a sus providers
     * **sync**. Default `false`: un roster que sólo lee y escribe por el MCP
     * de GitHub no necesita un checkout, y sin provisioner el run no clona ni
     * crea worktrees.
     *
     * Ponelo en `true` donde el roster **escriba código**. El motivo es que
     * `anthropic-api` es el piso de cualquier roster —lo que corre cuando
     * ningún remoto acepta la tarea—, así que dejarlo sin terreno hace que el
     * camino garantizado sea el único incapaz de trabajar: sus `fs_*` apuntan
     * a un path que nadie creó y `fs_write`/`bash_run` cortan en el guard de
     * `writePaths`. Con esto, el fallback aterriza en el mismo worktree que
     * le habría dado un agent-host remoto, y un solo prompt sirve para los dos.
     *
     * El clone base sale de `IA_FLOW_CONFIG_DIR/repos` (ver `reposBase` en
     * composition/container.ts), o sea el volumen que el deploy ya persiste —
     * no hace falta montar nada nuevo. Un `path` del catálogo de repos que no
     * exista en este disco se ignora con un warn y el repo se clona por sus
     * coordenadas `githubOwner`/`githubRepo` (`resolvePrimaryPath` en
     * @ia-flow/workspace).
     *
     * Como `remoteProviders`, NO mapea a una env var: lo lee el flavor
     * directo de la config y se lo pasa al container.
     */
    workspace: z.boolean().optional(),
    /**
     * Cuánta API expone este runner.
     *
     * `full` (default) monta el mismo set de routers que el flavor `full`.
     * Suena contradictorio para un "engine headless", pero es lo que hace que
     * el deploy siga siendo visible desde `apps/web`: su feature de servers
     * barre puertos y sondea `GET /api/projects` en cada uno, así que un
     * runner sin esa ruta desaparece del selector aunque esté corriendo
     * perfecto. Es el comportamiento que tenían estos contenedores antes de
     * los flavors, y publicarlo sólo en 127.0.0.1 es lo que lo hace aceptable
     * — esta API no tiene auth propia.
     *
     * `none` deja únicamente el webhook y /health. Es lo correcto donde el
     * puerto no es privado: en Kubernetes detrás de un ingress, o en
     * cualquier host donde no vayas a mirar ese runner desde la web.
     */
    api: z.enum(['full', 'none']).optional(),
    /**
     * Collector OTLP/HTTP al que exportar los logs. Vacío = sink apagado.
     * → OTEL_EXPORTER_OTLP_ENDPOINT
     *
     * El SDK viaja en TODAS las imágenes, siempre: el bundle del runner lo
     * incluye entero (exporter OTLP/HTTP incluido) y el flavor llama a
     * `initOtelSink()` en el boot. Un build sin telemetría deja un daemon
     * headless que sólo se puede diagnosticar entrando al contenedor.
     */
    otelEndpoint: z.string().optional(),
    /** Headers extra para el collector (`key=value,key2=value2`) — el api-key
     *  de Honeycomb/Datadog vive acá. → OTEL_EXPORTER_OTLP_HEADERS */
    otelHeaders: z.string().optional(),
    /** Kill switch: en `true` no se construye el sink aunque haya endpoint.
     *  → OTEL_SDK_DISABLED */
    otelDisabled: z.boolean().optional(),
  })
  // `.strict()`: un knob mal escrito tiene que romper el boot. Zod por default
  // descarta las claves que no conoce, y eso acá sería exactamente el fallo que
  // este bloque existe para evitar — una config que el operador cree aplicada y
  // el daemon nunca leyó.
  .strict()

export type RunnerSettings = z.infer<typeof RunnerSettingsSchema>

/**
 * Identidad con la que este runner habla con GitHub — la API, git y el MCP
 * oficial, los tres (ver packages/github-auth/CLAUDE.md).
 *
 * `privateKeyPath`, no `privateKey`: el PEM es lo único secreto del bloque y
 * se monta como archivo. Meterlo inline obligaría a que el `runner.yaml`
 * —que es config revisable y commiteable— dejara de serlo.
 *
 * Sin este bloque, la resolución cae a `auto` contra el env de siempre, que
 * es lo que hace que un `GITHUB_TOKEN` suelto siga funcionando sin config.
 */
export const RunnerGitHubAuthSchema = z
  .object({
    /** Para un daemon desatendido: `github-app` explícito. Un modo explícito
     *  falla ruidoso si la config está a medias, en vez de degradar a otra
     *  identidad en silencio. */
    mode: z.enum(['auto', 'static', 'gh-cli', 'github-app']).optional(),
    appId: z.string().optional(),
    installationId: z.string().optional(),
    /** Path al `.pem` DENTRO del contenedor. → IA_FLOW_GITHUB_APP_PRIVATE_KEY_PATH */
    privateKeyPath: z.string().optional(),
  })
  .strict()

export type RunnerGitHubAuth = z.infer<typeof RunnerGitHubAuthSchema>

/**
 * Server principal al que este runner reenvía logs y ejecuciones.
 *
 * Una sola URL base: las dos rutas (`/api/remote-logs`, `/api/remote-executions`)
 * las deriva el loader. Declararlas por separado —como hacían las tres env
 * vars que esto reemplaza— es repetir el mismo host y permitir que apunten a
 * daemons distintos, que nunca es lo que alguien quiso.
 */
export const RunnerUpstreamSchema = z
  .object({
    // `.url()` a secas acepta `localhost:3001` (lo parsea como protocolo
    // `localhost:`), que es justo el típo que alguien va a cometer acá.
    url: z
      .string()
      .url()
      .refine((u) => u.startsWith('http://') || u.startsWith('https://'), {
        message: 'upstream.url tiene que empezar con http:// o https://',
      }),
    /** El server del otro lado rechaza con 503 si no matchea. */
    token: z.string().optional(),
  })
  .strict()

export type RunnerUpstream = z.infer<typeof RunnerUpstreamSchema>

/**
 * El archivo completo.
 *
 * `projects`/`agents`/`rules`/`mcp` son los MISMOS schemas que ya validan los
 * cuatro YAML de hoy — no hay un dialecto nuevo que aprender, sólo un archivo en vez
 * de cuatro.
 *
 * `repos` es opcional y sus entradas pueden no tener `path`: con
 * `settings.workspace` apagado (el default) el catálogo existe para que el
 * agente sepa qué repo es cuál (nombre corto → `owner/repo` + descripción),
 * no para apuntar a un checkout. El `path` sólo lo consume un provisioner de
 * workspace, y ahí alcanza con `githubOwner`/`githubRepo`: el provisioner
 * clona por coordenadas si no encuentra el path en este disco.
 */
export const RunnerConfigSchema = z
  .object({
    settings: RunnerSettingsSchema.optional(),
    github: RunnerGitHubAuthSchema.optional(),
    upstream: RunnerUpstreamSchema.optional(),
    /**
     * Sin `.min(1)`: los proyectos pueden venir enteros de la carpeta
     * `projects/`, y el schema valida el archivo ANTES del merge. El "al menos
     * uno" lo chequea el loader sobre el resultado final, que es el único
     * lugar donde la pregunta tiene sentido.
     */
    projects: ProjectSchema.array().default([]),
    repos: RepoDefSchema.array().default([]),
    agents: AgentDefinitionSchema.array().default([]),
    /**
     * Qué dispara a cada agente.
     *
     * Obligatoria en la práctica desde la migración 059: el agente ya no
     * declara su activación, así que un deploy sin reglas no corre NADA. El
     * schema la deja vacía por default para no romper el parseo del archivo,
     * y el loader avisa — un roster que no dispara es el fallo más caro de
     * este sistema porque es silencioso.
     */
    rules: RuleSchema.array().default([]),
    mcp: McpCatalogEntrySchema.array().default([]),
  })
  .strict()

export type RunnerConfig = z.infer<typeof RunnerConfigSchema>
