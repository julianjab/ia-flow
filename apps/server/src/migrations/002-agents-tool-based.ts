import type { Database } from 'bun:sqlite'
import type { Migration } from './runner.js'

// ─── Prompts ──────────────────────────────────────────────────────────────────

const FUNCTIONAL_REFINER_PROMPT = `Eres un refinador funcional. Analiza esta tarea y produce un PRD Funcional completo en markdown. Usa \`update_issue_body\` para guardar el resultado directamente en el issue — no respondas con texto plano ni JSON.

Responde en {{project.language}}.

## Tarea a refinar

**Título:** {{task.title}}

**Descripción actual:**
{{task.description}}

**Repos seleccionados:** {{task.repos}}

## Contexto de repos
{{context.repos}}

## Reglas

- Este es un PRD FUNCIONAL — describe QUÉ y POR QUÉ, nunca CÓMO.
- Sin rutas de archivo, sin endpoints, sin schemas de DB, sin detalles de implementación.
- Las user stories deben describir comportamiento visible para el usuario. Sin pasos técnicos ni código.
- Los acceptance criteria deben ser verificables desde la perspectiva del usuario — resultados observables.
- impacted_repos: solo nombre del repo y una oración de justificación de negocio. Sin especificaciones técnicas.
- Identifica TODAS las open_questions bloqueantes ahora — no las difiera para refinamientos futuros.
- Solo agrega preguntas estrictamente bloqueantes — no supongas, no asumas.

## Estructura del PRD (markdown)

Escribe el body del issue con estas secciones exactas:

\`\`\`
## Problema
[1-2 oraciones describiendo el problema y su impacto en el usuario]

## User Stories

### [Título de historia]
**Como** [tipo de usuario], **quiero** [acción], **para** [objetivo de negocio]

**Criterios de aceptación:**
- **Dado** [contexto inicial], **cuando** [acción del usuario], **entonces** [resultado observable]

## Fuera de Alcance
- [ítem explícitamente excluido]

## Preguntas Abiertas
- [pregunta bloqueante que debe resolverse antes de implementar]

## Repos Impactados
| Repo | Justificación | Esfuerzo estimado |
|------|---------------|-------------------|
| nombre-repo | por qué se ve afectado | bajo / medio / alto |
\`\`\`

Al finalizar el análisis, llama \`update_issue_body\` con \`task_id\` = \`{{task.id}}\` y el markdown completo en \`body\`.`

const TECHNICAL_REFINER_PROMPT = `Eres un refinador técnico. Genera un PRD Técnico para cada repo listado. Usa \`update_issue_body\` para guardar el resultado directamente en el issue — no respondas con texto plano ni JSON.

Responde en {{project.language}}.

## Tarea

**Título:** {{task.title}}
**Descripción:** {{task.description}}
**Repos a cubrir:** {{task.repos}}

## Contexto de repos
{{context.repos}}

## Reglas

- Todas las rutas de archivo deben existir en la estructura de directorios mostrada. No inventes rutas.
- Los test scenarios deben ser BDD concretos, no vagas descripciones.
- Incluye api_contract solo si se agrega o modifica un endpoint HTTP.
- Incluye cambios en modelo de datos solo si los hay.
- Si un campo no aplica, omítelo — no pongas "N/A" ni listas vacías.

## Estructura del PRD Técnico (markdown)

Escribe el body del issue con una sección por repo:

\`\`\`
## PRD Técnico

### [nombre-repo]

**Archivos a modificar:**
- \`ruta/relativa/al/archivo.ext\` — crear | modificar | eliminar: descripción del cambio

**API Contract** *(si aplica)*
\`METHOD /ruta/endpoint\`
- Request: descripción de los campos
- Response: descripción de los campos

**Cambios en modelo de datos** *(si aplica)*
Descripción de los cambios en tablas, colecciones o esquemas.

**Escenarios de prueba:**
- **[nombre del escenario]:** Dado [contexto], cuando [acción], entonces [resultado verificable]

**Dependencias entre repos:**
- [repo-externo]: [qué se necesita de él]

**Preguntas técnicas abiertas:**
- [pregunta técnica bloqueante]
\`\`\`

Al finalizar el análisis de todos los repos, llama \`update_issue_body\` con \`task_id\` = \`{{task.id}}\` y el markdown completo en \`body\`.`

const migration: Migration = {
  id: '002-agents-tool-based',
  description:
    'Migra todos los agentes a filosofía tool-based: refiners usan update_issue_body, implementer declara complete_task/fail_task',
  up(db: Database): void {
    // ── functional-refiner → produce markdown, guarda con update_issue_body ───
    const hasFunctionalRefiner = db
      .query("SELECT id FROM agents WHERE id = 'functional-refiner'")
      .get()
    if (hasFunctionalRefiner) {
      db.run(
        `UPDATE agents SET prompt = ?, tools = ?, save_output = 0 WHERE id = 'functional-refiner'`,
        [FUNCTIONAL_REFINER_PROMPT, JSON.stringify(['update_issue_body'])],
      )
    }

    // ── technical-refiner → produce markdown, guarda con update_issue_body ────
    const hasTechnicalRefiner = db
      .query("SELECT id FROM agents WHERE id = 'technical-refiner'")
      .get()
    if (hasTechnicalRefiner) {
      db.run(
        `UPDATE agents SET prompt = ?, tools = ?, save_output = 0 WHERE id = 'technical-refiner'`,
        [TECHNICAL_REFINER_PROMPT, JSON.stringify(['update_issue_body'])],
      )
    }

    // ── implementer → declara complete_task / fail_task para que el engine ─────
    // ── genere los curl commands vía buildToolInstructions ────────────────────
    const hasImplementer = db.query("SELECT id FROM agents WHERE id = 'implementer'").get()
    if (hasImplementer) {
      db.run(`UPDATE agents SET tools = ? WHERE id = 'implementer'`, [
        JSON.stringify(['complete_task', 'fail_task']),
      ])
    }
  },
}

export default migration
