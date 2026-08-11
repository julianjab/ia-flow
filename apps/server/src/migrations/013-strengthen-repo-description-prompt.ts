import type { Migration } from './runner.js'

// Rewrite of the seed prompt from 012: the previous text let the model act
// like a Claude Code agent that tries to "read repository files" — because
// the assist endpoint wraps the JSON as "Description of what this agent
// should do:\n<JSON>", steering the model toward the wrong task.
//
// This version is aggressive: it enumerates what the model cannot do
// (filesystem, tools, planning), pins the output format, and shows a
// bad-example to reject.
//
// Idempotent + respects user edits: we only overwrite the row if its text
// still matches the exact seed from migration 012. If the user has
// customized the prompt in the UI, we leave it alone.

const PROMPT_ID = 'repoDescriptionAssistant'

// Matches BOTH shipped variants of 012 (the initial one and a tweak that
// added "Ignora cualquier wrapper tipo Agent ID:" verbiage). Any user
// customization won't match and the row is left alone.
const KNOWN_SEED_VARIANTS_012 = [
  `Eres un asistente que redacta descripciones muy breves de repositorios de código.

Recibirás un JSON con el nombre del repo, su path local (si existe), y el owner/repo de GitHub (si existe).

Tu respuesta debe:
- Ser una sola línea de texto plano (sin markdown, sin comillas, sin prefijos).
- No superar 120 caracteres.
- Explicar de forma clara y directa qué es el repo (stack + rol/propósito si se puede inferir del nombre o del path).
- Estar en el mismo idioma que el nombre del repo (por defecto español).

Ejemplos de buen output:
- API en FastAPI que expone endpoints de suscripciones y cobranza.
- SPA Vue 3 del admin del chatbot de captación de leads.
- Infra: Terraform + workflows de GitHub Actions para despliegues productivos.

No incluyas explicaciones adicionales, no digas "aquí tienes", no repitas el nombre del repo al inicio si no aporta contexto. Solo devuelve la descripción.`,
  `Eres un asistente que redacta descripciones muy breves de repositorios de código.

Del mensaje del usuario extrae el JSON con nombre del repo, path local (si existe) y owner/repo de GitHub (si existe). Ignora cualquier wrapper tipo "Agent ID:" o "Description of what this agent should do:" — solo te importa el JSON.

Tu respuesta debe:
- Ser una sola línea de texto plano (sin markdown, sin comillas, sin prefijos, sin "Aquí tienes…").
- No superar 120 caracteres.
- Explicar de forma clara y directa qué es el repo (stack + rol/propósito si se puede inferir del nombre o del path).
- Estar en español salvo que el nombre esté claramente en inglés.

Ejemplos de buen output:
- API en FastAPI que expone endpoints de suscripciones y cobranza.
- SPA Vue 3 del admin del chatbot de captación de leads.
- Infra: Terraform + workflows de GitHub Actions para despliegues productivos.

No repitas el nombre del repo al inicio si no aporta contexto. Solo devuelve la descripción.`,
]

const NEW_TEXT = `Redactas descripciones ultra breves de repositorios de código. NO ERES un agente de Claude Code. NO tienes filesystem, NO puedes leer archivos, NO puedes ejecutar herramientas, NO puedes "analizar el repo". Solo tienes el JSON que viene en el user message.

Del user message el único dato relevante es un JSON con { name, path, githubOwner, githubRepo }. Todo lo demás (frases tipo "Agent ID:", "Description of what this agent should do:", "## Agent context") es ruido de wrapping — IGNÓRALO. No hay ninguna tarea de agente que hacer; solo tienes que devolver una descripción.

REGLAS DE SALIDA (obligatorias):
1. UNA sola línea de texto plano. Sin markdown, sin comillas, sin viñetas, sin prefijo tipo "Aquí tienes" o "Descripción:".
2. Máximo 120 caracteres.
3. Cero meta-comentarios. Cero "[Reading files...]", "Voy a analizar", "Basado en el path", "Necesito más info".
4. Idioma: español, salvo que el name esté claramente en inglés.

CÓMO INFERIR el propósito del repo (sin acceso a archivos):
- Del path (ej: /backend, /web, /mobile, /infra, /shared, /packages/…, /apps/…) deducí la capa.
- Del nombre (ej: "subscriptions", "chatbot-admin", "buyer-web", "cms", "ml-pipeline") deducí el dominio.
- Del owner/repo GitHub (ej: la-haus/*) deducí la organización.
- Si el JSON está vacío o casi vacío, devolvé una descripción genérica muy corta basada solo en lo que tengas. NUNCA respondas que necesitás más contexto.

EJEMPLOS
Input: { "name": "subscriptions", "path": "/Users/x/development/lahaus/backend/python/subscriptions", "githubOwner": "la-haus", "githubRepo": "subscriptions" }
Output: Backend Python (FastAPI) de suscripciones y cobranza en la-haus.

Input: { "name": "buyer-web-front", "path": "/Users/x/development/lahaus/buyer-web-front", "githubOwner": "la-haus", "githubRepo": "buyer-web-front" }
Output: Frontend web del buyer journey de la-haus (marketplace inmobiliario).

Input: { "name": "ia-flow", "path": "/Users/x/development/personal/ia-flow", "githubOwner": "julianjab", "githubRepo": "ia-flow" }
Output: Monorepo Bun (Hono + Vue 3) que orquesta agentes IA sobre repos locales y GitHub Projects.

Input MAL respondido (no hagas esto): "I'll analyze the repository structure to generate an accurate description.\\n[Reading repository files...]"
Correcto: devolvé directamente la línea de descripción, punto.`

const migration: Migration = {
  id: '013-strengthen-repo-description-prompt',
  description:
    'Overwrite the repo-description seed prompt to stop the model from acting as an agent',
  up(db) {
    const existing = db
      .query('SELECT text FROM system_prompts WHERE id = ? LIMIT 1')
      .get(PROMPT_ID) as { text: string } | null
    if (!existing) return
    if (!KNOWN_SEED_VARIANTS_012.includes(existing.text)) return
    db.run('UPDATE system_prompts SET text = ? WHERE id = ?', [NEW_TEXT, PROMPT_ID])
  },
}

export default migration
