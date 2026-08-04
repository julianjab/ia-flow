import Anthropic from '@anthropic-ai/sdk'
import type { Task, FunctionalPRD, RepoContext } from '@ia-flow/shared'

const PLACEHOLDER_PRD: FunctionalPRD = {
  problem_statement: 'ANTHROPIC_API_KEY not configured. Set the key in apps/server/.env to enable AI refinement.',
  user_stories: [
    {
      as_a: 'developer',
      i_want: 'to configure the API key',
      so_that: 'the AI agents can generate real PRDs',
      acceptance_criteria: [
        {
          given: 'the server is running',
          when: 'ANTHROPIC_API_KEY is set in .env',
          then: 'the functional refiner produces a real PRD',
        },
      ],
    },
  ],
  out_of_scope: ['AI-generated content (API key required)'],
  open_questions: ['What is the ANTHROPIC_API_KEY?'],
  impacted_repos: [],
}

function buildSystemPrompt(): string {
  return `You are a senior product engineer at LaHaus, a proptech company operating in Latin America (Colombia and Mexico).
Your job is to refine developer task descriptions into structured Functional PRDs.

LaHaus context:
- Primary services: subscriptions (Python/FastAPI), customer-platform (Go), comms-api (Go), buyer-web-front (Nuxt 3)
- Key domains: lead lifecycle, AI agents (Samara), fintech payments, real estate listings
- Stack: Go microservices, Python FastAPI, Vue 3/Nuxt 3, PostgreSQL, Redis, AWS
- Events: Snowplow tracking, SQS messaging

Return ONLY valid JSON matching this exact schema (no markdown, no explanation):
{
  "problem_statement": "string",
  "user_stories": [
    {
      "as_a": "string",
      "i_want": "string",
      "so_that": "string",
      "acceptance_criteria": [
        { "given": "string", "when": "string", "then": "string" }
      ]
    }
  ],
  "out_of_scope": ["string"],
  "open_questions": ["string"],
  "impacted_repos": [
    {
      "repo": "string",
      "rationale": "string",
      "estimated_effort": "low|medium|high"
    }
  ]
}`
}

function buildUserPrompt(task: Task, contexts: RepoContext[]): string {
  const contextSections = contexts
    .map((ctx) => {
      const parts: string[] = [`### Repo: ${ctx.name} (${ctx.type})`]
      if (ctx.claude_md) parts.push(`CLAUDE.md:\n${ctx.claude_md.slice(0, 1500)}`)
      if (ctx.manifest) parts.push(`Manifest:\n${ctx.manifest.slice(0, 800)}`)
      if (ctx.directory_tree) parts.push(`Structure:\n${ctx.directory_tree.slice(0, 600)}`)
      return parts.join('\n\n')
    })
    .join('\n\n---\n\n')

  return `Task to refine:
Title: ${task.title}
Description: ${task.description}
Selected repos: ${task.repos.join(', ')}

Repo contexts:
${contextSections || 'No repo contexts available.'}

Generate a complete Functional PRD for this task.`
}

export async function refineFunctionalTask(
  task: Task,
  contexts: RepoContext[],
): Promise<FunctionalPRD> {
  const apiKey = Bun.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    console.warn('[functional-refiner] ANTHROPIC_API_KEY not set, returning placeholder')
    return PLACEHOLDER_PRD
  }

  const client = new Anthropic({ apiKey })

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 4096,
      system: buildSystemPrompt(),
      messages: [
        {
          role: 'user',
          content: buildUserPrompt(task, contexts),
        },
      ],
    })

    const text = message.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join('')

    // Strip markdown code fences if present
    const jsonStr = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()

    return JSON.parse(jsonStr) as FunctionalPRD
  } catch (err) {
    console.error('[functional-refiner] Error calling Claude:', err)
    throw err
  }
}
