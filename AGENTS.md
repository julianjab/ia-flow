# ia-flow — Agents, commands & hooks

Índice del toolkit de Claude Code de este repo. Ver [CLAUDE.md](./CLAUDE.md) para reglas del proyecto.

## Subagents (`.claude/agents/`)

### Verificadores (read-only, model: haiku)
| Agent | Cuándo se dispara | Qué hace |
|---|---|---|
| `server-verifier` | Cambios en `apps/server/**` | Biome + `bun test` server + sanity en `index.ts` |
| `web-verifier` | Cambios en `apps/web/**` | Biome + `vue-tsc --noEmit` + vitest |

### Ejecutores de código (model: sonnet)
| Agent | Cuándo se dispara | Qué hace |
|---|---|---|
| `feature-implementer` | Feature end-to-end en server | Vertical hexagonal: schema Zod en `shared` → port en `domain` → impl en `infrastructure`/`adapters` → use-case en `application` → cableado en `container.ts` → router Hono → migración si aplica → tests colocados |
| `vue-component-builder` | Componentes Vue nuevos | `<script setup>` + Pinia composition + tests `.spec.ts`, dentro de su feature slice (`features/<dominio>/`) o `ui/` |
| `migration-writer` | "Nueva migración", "add migration" | Migración SQLite consistente + registro en `runner.ts` |
| `test-writer` | Código sin cobertura | Detecta runner (bun:test vs vitest) y genera tests AAA |
| `debugger` | Bug reportado, stack trace, comportamiento inesperado | Diagnóstico root-cause + fix mínimo + test de regresión |

### Auditores (read-only, model: sonnet)
| Agent | Cuándo se dispara | Qué hace |
|---|---|---|
| `architecture-guardian` | Antes de commit si el diff agrega archivos, carpetas o imports entre capas | Audita la regla de dependencia (hexagonal en server, feature-sliced en web, contract-only en shared) y distingue deuda nueva de la preexistente |
| `shared-schema-guardian` | Antes de commit si `packages/shared/**` cambió | Verifica scope del contrato + compat de call-sites en server + web |
| `engine-agent-author` | "Crear/mejorar un agente del engine", editar `agents/*/agents.*.yaml`, agente que no dispara o loopea | Diseña la `AgentDefinition`: activación → cierre de ciclo → tools mínimas → prompt. Carga el skill `ia-flow-agent-authoring` |
| `code-reviewer` | Antes de commit/PR | Checklist OWASP + convenciones ia-flow, findings con severidad |
| `pr-writer` | Al abrir PR o redactar commit grande | Conventional Commits + body con Summary/Changes/Test plan |

## Skills (`.claude/skills/`)

| Skill | Cuándo se carga | Qué aporta |
|---|---|---|
| `ia-flow-agent-authoring` | Crear/editar/depurar agentes del **engine** (`AgentDefinition`), diseñar pipelines de labels o statuses, elegir tools/provider/MCP | `SKILL.md` con el modelo mental + checklist, y `references/` cargadas bajo demanda: `agent-definition`, `activation-and-outcomes`, `dispatch-gates`, `tools`, `providers-and-mcp`, `variables`, `patterns` |

> Ojo con la ambigüedad del término: los agentes de `.claude/agents/` son **subagentes de
> Claude Code**; los del skill de arriba son **agentes del engine** (filas de `agents` /
> `agents/*/agents.*.yaml`) que el daemon corre contra issues.

## Slash commands (`.claude/commands/`)

| Command | Uso | Delega en |
|---|---|---|
| `/check [--all]` | Gate de calidad: biome + typecheck + tests de workspaces tocados | — |
| `/migrate <nombre>` | Crear migración SQLite | `migration-writer` |
| `/add-route <recurso>` | Scaffold de router Hono nuevo | — |

## Hooks (`.claude/hooks/` + `.claude/settings.json`)

| Hook | Evento | Efecto |
|---|---|---|
| `block-branch.sh` | `PreToolUse` Bash | Bloquea `git checkout -b`, `git switch -c`, `git branch <name>` (ia-flow es main-only) |
| `biome-check.sh` | `PostToolUse` Edit/Write/MultiEdit | Auto-format silencioso con Biome del archivo editado |

## Settings (`.claude/settings.json`)

- **Default mode:** `acceptEdits`
- **Allow:** Read/Grep/Glob, `bun *`, `bunx *`, `git status/diff/log/show/add/commit/stash`, `gh api/pr view/issue view`
- **Ask:** `git push`, `gh pr create/comment`, `bun install`, `Write **/*.env*`
- **Deny:** `Read **/.env*`, `rm -rf`, `gh pr merge`, `git push --force`, `git reset --hard`

## Convenciones para autores de agents

1. **Frontmatter obligatorio:** `name`, `description` (con trigger explícito "Use proactively/when..."), `tools`, `model`.
2. **Un solo tema por agent.** Si haces dos cosas, son dos agents.
3. **Máx ~200 líneas de cuerpo.** El agent devuelve resumen, no código pegado.
4. **Reglas duras explícitas** en la sección "Reglas" (qué NO hacer).
5. **Cita fuentes oficiales** al final si el agent implementa patrones.
6. **Verificadores usan `haiku`**, ejecutores y auditores `sonnet`. Nadie usa `opus` por default.
7. **Los ejecutores llaman al verificador correspondiente** al terminar, y a `architecture-guardian`
   si el cambio agregó archivos, carpetas o cruces entre capas.
8. **Los agents citan rutas reales.** Antes de escribir un path en un agent, verifícalo con `Glob`:
   un agent que enseña una estructura que ya no existe produce código que viola la arquitectura.
