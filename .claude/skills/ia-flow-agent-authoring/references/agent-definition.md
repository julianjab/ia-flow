# AgentDefinition — campo por campo

Fuente: `packages/shared/src/schemas.ts` → `AgentDefinitionSchema`
(= base + `AgentActivationSchema` + `AgentOutcomesSchema`).

## Identidad y ejecución

| Campo | Tipo | Notas |
| --- | --- | --- |
| `id` | `string` (requerido) | Único. Aparece en logs, `execution_logs.agentId` y en los comentarios que publica el agente. |
| `provider` | `string` (requerido) | `anthropic-api` \| `tmux-claude` \| `iterm-claude`. |
| `prompt` | `string` (requerido) | Prompt de usuario. Se le resuelven `{{variables}}` y se le **prepende** un bloque "## Git context" generado por el engine. |
| `systemPrompts` | `Array<string \| {text}>` | Ids de `SystemPromptDef` reusables y/o texto inline, en orden. Se concatenan después de los defaults del proyecto. |
| `variables` | `Record<string, string \| {value, full?, description?}>` | Valores propios del agente, accesibles como `{{variables.KEY}}` y `{{variables.KEY.full}}`. |
| `tools` | `Array<string \| BashRunConfig>` | Lista plana. Sin ella (o vacía) el agente **no tiene tools** salvo las internas. Ver `tools.md`. |
| `providerConfig` | `Record<string, unknown>` | Blob validado con schema **strict** por cada provider. Ver `providers-and-mcp.md`. |
| `mcpCatalogIds` | `string[]` | Ids del catálogo MCP; se expanden y mergean en `providerConfig.mcpServers` al dispatch. Los `mcpServers` inline ganan. |
| `requiresBranch` | `boolean` | Override del gate de linked branch. `undefined` = derivado de "¿tiene write tools?". `true` = siempre crear branch (caso MCP-only). `false` = nunca. |
| `save_output` | `boolean` | **Legacy.** Sólo existe como columna en SQLite; ningún código del runtime lo lee hoy. No lo uses para diseñar comportamiento. |

## Activación (`AgentActivationSchema`)

| Campo | Tipo | Semántica |
| --- | --- | --- |
| `projectId` | `string \| null` | `null` = agente global, elegible en cualquier proyecto. |
| `repoName` | `string \| null` | `null` = cualquier repo. Matchea por pertenencia contra `task.repos[]`. Un issue sin refinar (`repos: []`) sólo lo pueden tomar agentes sin `repoName`. |
| `statusName` | `string \| null` | `null` = cualquier status. Comparación case-insensitive. |
| `when` | `WhenCondition[] \| Record<string,string>` | Condiciones contra los campos del issue. Ver `activation-and-outcomes.md`. |
| `allowBlocked` | `boolean` | Default `false`: si el issue tiene dependencias abiertas, se skipea. `true` corre igual. (El `allowBlocked` de `StatusConfig` está **deprecado**, no lo uses.) |
| `enabled` | `boolean` | `false` = nunca candidato. |
| `position` | `number` | Desempate **dentro de su scope**. Los agentes con `projectId` siempre preceden a los globales. |

## Outcomes (`AgentOutcomesSchema`)

| Campo | Cuándo se aplica |
| --- | --- |
| `onProcess` | Al arrancar el run, antes de llamar al provider. |
| `onFinish` | Run exitoso (incluye `complete_task`). |
| `onError` | Run fallido (incluye `fail_task`). |

Un solo canal por slot: todo lo que el agente escribe de vuelta va por `$set:` contra los
campos del source **según su definición** — los de un valor se asignan, los multi-valor
(`Labels`) reciben tokens `+`/`-`/`=`. Un nombre de status pelado es la forma corta de
`$set:status=<nombre>`. Ver `activation-and-outcomes.md`.

Si una tool ya movió el issue durante el run, el engine **no** lo pisa con el outcome.

> Los campos `onProcessLabels` / `onFinishLabels` / `onErrorLabels` (prefijo `$labels:`)
> **ya no existen**: eran un segundo canal que aplicaba las labels con otra primitiva
> (`setLabels`) y obligaba a la UI a partir una misma fila del editor en dos lugares.
> Migración 039 los convirtió a `$set:Labels=...` y dropeó las columnas.

## YAML canónico (roster headless)

```yaml
# Shape: AgentDefinitionSchema[]
- id: mi-agente
  provider: anthropic-api
  projectId: subscriptions        # omitir = global
  repoName: subscriptions         # omitir = cualquier repo del proyecto
  statusName: Ready               # o gatear por labels con `when`
  enabled: true
  position: 10
  allowBlocked: false
  requiresBranch: true
  tools:
    - read_file
    - grep_files
    - name: bash_run
      allow: ['uv run pytest *', 'git status', 'git diff *']
      deny: ['git push *', 'rm *']
  mcpCatalogIds: [github-mcp]
  providerConfig:
    model: claude-sonnet-5        # opcional
    maxTokens: 24000
    effort: high
  systemPrompts:
    - reglas-lahaus-python        # id de SystemPromptDef
    - text: Responde siempre en español.
  variables:
    CONVENTIONS:
      value: snake_case en payloads y DB
      description: Convención de naming del repo
  onProcess: '$set:Labels=-agent:build'
  onFinish: '$set:status=In Review,Labels=+agent:review'
  onError: '$set:status=Blocked,Labels=+blocked'
  prompt: |
    ...
```

## Dónde se persiste

- **Runtime normal:** tabla `agents` (SQLite). CRUD por la web (`AgentEditorModal.vue`) y la API.
  Ojo: la UI sólo administra la parte `string` de `systemPrompts`; las entradas `{text}`
  inline se preservan pero no son editables ahí.
- **Deploy headless:** `<deploy>/projects/<projectId>/agents/<NN>-<nombre>.yaml`
  — un archivo por agente, dentro de la carpeta de su proyecto (que le pone el
  `projectId`). Los globales van en `<deploy>/agents/`. Los carga
  `YamlAgentRepository` (read-only, sin CRUD en runtime). El orden alfabético de los
  archivos ES el orden de declaración: importa cuando ningún agente declara `position`,
  y los globales se leen antes que los de un proyecto.
