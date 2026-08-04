// Orchestrator — builds prompts per step and routes to the configured provider
import type { RepoContext } from '@ia-flow/shared'
import { getStepProvider, resolveStepSettings, loadProviderConfig } from '../providers/index.js'
import type { StepOutput, StepType } from '../providers/index.js'

interface TaskMeta {
  title: string
  description: string
  type: string
  repos: string[]
  comments?: string[]
  checkboxAnswers?: Array<{ question: string; selected: string[] }>
  // GitHub context — passed to async providers so they can call back the daemon
  issueId?: string
  issueNumber?: number
  issueBody?: string
  repoName?: string
  owner?: string
  itemId?: string
  projectId?: string
  statusFieldId?: string
  inReviewOptionId?: string
}

// ─── Functional refinement ────────────────────────────────────────────────

export async function orchestrateRefine(
  task: TaskMeta,
  contexts: RepoContext[],
): Promise<{ prdJson: string; output: StepOutput }> {
  const step: StepType = task.type.toLowerCase() === 'technical' ? 'refine-technical' : 'refine-functional'
  const provider = await getStepProvider(step)

  const contextSections = contexts
    .map((ctx) => {
      const parts: string[] = [`### Repo: ${ctx.name} (${ctx.type})`]
      if (ctx.claude_md) parts.push(`CLAUDE.md:\n${ctx.claude_md.slice(0, 1500)}`)
      if (ctx.manifest) parts.push(`Manifest:\n${ctx.manifest.slice(0, 800)}`)
      if (ctx.directory_tree) parts.push(`Structure:\n${ctx.directory_tree.slice(0, 800)}`)
      return parts.join('\n\n')
    })
    .join('\n\n---\n\n')

  const config = await loadProviderConfig()
  const { settings } = resolveStepSettings(step, config)
  const lang = settings.responseLanguage ?? 'english'

  const prompt =
    task.type.toLowerCase() === 'technical'
      ? buildTechnicalPrompt(task, contextSections)
      : buildFunctionalPrompt(task, contextSections)

  const daemonUrl = `http://localhost:${Bun.env.PORT ?? 3001}`

  const output = await provider.run({
    step,
    taskTitle: task.title,
    taskDescription: task.description,
    taskType: task.type,
    repos: task.repos,
    contexts,
    prompt,
    issueId: task.issueId,
    issueNumber: task.issueNumber,
    issueBody: task.issueBody,
    repoName: task.repoName,
    itemId: task.itemId,
    projectId: task.projectId,
    daemonUrl,
  })

  return { prdJson: output.content, output }
}

// ─── Implementation dispatch (per repo) ──────────────────────────────────

export async function orchestrateImplement(
  task: TaskMeta,
  prdJson: string,
  contexts: RepoContext[],
): Promise<StepOutput[]> {
  const provider = await getStepProvider('implement')
  const results: StepOutput[] = []

  const daemonUrl = `http://localhost:${Bun.env.PORT ?? 3001}`

  for (const ctx of contexts) {
    const prompt = buildImplementPrompt(task, prdJson, ctx)
    const output = await provider.run({
      step: 'implement',
      taskTitle: task.title,
      taskDescription: task.description,
      taskType: task.type,
      repos: task.repos,
      contexts: [ctx],
      prompt,
      cwd: ctx.path,
      issueId: task.issueId,
      issueNumber: task.issueNumber,
      repoName: task.repoName,
      owner: task.owner,
      itemId: task.itemId,
      projectId: task.projectId,
      statusFieldId: task.statusFieldId,
      inReviewOptionId: task.inReviewOptionId,
      daemonUrl,
    })
    results.push(output)
  }

  return results
}

// ─── Technical decomposition (Functional → Technical sub-issues) ─────────

export interface TechnicalSubTask {
  title: string
  repo: string
  description: string
  files_to_modify: Array<{ path: string; change_type: string; description: string }>
  api_contract?: { endpoint: string; method: string; request_schema: object; response_schema: object }
  data_model_changes: string | null
  test_scenarios: Array<{ scenario: string; given: string; when: string; then: string }>
  dependencies: Array<{ repo: string; what: string }>
  open_questions: Array<string | { question: string; options: string[] }>
}

export async function orchestrateTechnicalDecompose(
  task: TaskMeta,
  functionalPrdMarkdown: string,
  contexts: RepoContext[],
): Promise<TechnicalSubTask[]> {
  const provider = await getStepProvider('refine-technical')

  const contextSections = contexts
    .map((ctx) => {
      const parts: string[] = [`### Repo: ${ctx.name} (${ctx.type})`]
      if (ctx.claude_md) parts.push(`CLAUDE.md:\n${ctx.claude_md.slice(0, 1500)}`)
      if (ctx.manifest) parts.push(`Manifest:\n${ctx.manifest.slice(0, 800)}`)
      if (ctx.directory_tree) parts.push(`Structure:\n${ctx.directory_tree.slice(0, 800)}`)
      return parts.join('\n\n')
    })
    .join('\n\n---\n\n')

  const prompt = buildTechnicalDecomposePrompt(task, functionalPrdMarkdown, contextSections)
  const daemonUrl = `http://localhost:${Bun.env.PORT ?? 3001}`

  const output = await provider.run({
    step: 'refine-technical',
    taskTitle: task.title,
    taskDescription: task.description,
    taskType: task.type,
    repos: task.repos,
    contexts,
    prompt,
    issueId: task.issueId,
    issueNumber: task.issueNumber,
    issueBody: task.issueBody,
    repoName: task.repoName,
    itemId: task.itemId,
    projectId: task.projectId,
    daemonUrl,
  })

  const raw = output.content.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
  try {
    return JSON.parse(raw) as TechnicalSubTask[]
  } catch (e) {
    // Truncated response — surface a clear error with a snippet for diagnosis
    const preview = raw.length > 300 ? `${raw.slice(-300)}…` : raw
    throw new Error(`JSON parse failed (response likely truncated at max_tokens). Last 300 chars:\n${preview}`)
  }
}

// ─── Translation step (Haiku) ─────────────────────────────────────────────

async function translateJson(jsonStr: string, targetLang: string): Promise<string> {
  const token = Bun.env.CLAUDE_CODE_OAUTH_TOKEN
  const apiKey = Bun.env.ANTHROPIC_API_KEY
  const authHeader = token
    ? { Authorization: `Bearer ${token}` }
    : apiKey
      ? { 'x-api-key': apiKey }
      : null

  if (!authHeader) return jsonStr  // no auth — skip translation

  const body = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 8192,
    system: 'You are a professional translator. Translate only the string values inside JSON, keeping all keys, structure, and non-string values (numbers, booleans, null) unchanged. Return ONLY the translated JSON, no markdown, no explanation.',
    messages: [
      {
        role: 'user',
        content: `Translate all string values in this JSON to ${targetLang}. Keep JSON keys in English. Return ONLY the JSON:\n\n${jsonStr}`,
      },
    ],
  }

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...authHeader },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      console.warn(`[translate] Haiku ${res.status} — returning original`)
      return jsonStr
    }
    const data = await res.json() as any
    const text = (data.content as any[]).filter((b) => b.type === 'text').map((b) => b.text as string).join('')
    return text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
  } catch (e) {
    console.warn('[translate] Failed — returning original:', e)
    return jsonStr
  }
}

// ─── Prompt builders ──────────────────────────────────────────────────────

function buildCommentsSection(comments: string[] | undefined): string {
  if (!comments?.length) return ''
  return `\nTeam answers to open questions (via comments):\n${comments.map((c, i) => `[${i + 1}] ${c}`).join('\n\n')}\n`
}

function buildCheckboxSection(answers: Array<{ question: string; selected: string[] }> | undefined): string {
  if (!answers?.length) return ''
  const lines = answers.map((a) => `- "${a.question}" → selected: ${a.selected.join(', ')}`)
  return `\nQuestions answered via checkboxes in the issue body (do NOT re-ask these):\n${lines.join('\n')}\n`
}

function buildFunctionalPrompt(task: TaskMeta, contextSections: string): string {
  return `Refine this task into a Functional PRD. Follow the template exactly — no extra fields, no exceeding limits.

Task:
Title: ${task.title}
Description: ${task.description}
Selected repos: ${task.repos.join(', ')}
${buildCheckboxSection(task.checkboxAnswers)}${buildCommentsSection(task.comments)}
Repo contexts:
${contextSections || 'No repo context provided.'}

Rules:
- Never invent file paths. Only reference files visible in the structure above.
- Identify ALL blocking open_questions upfront in this pass — do not defer questions to future refinements.
- Only add to open_questions what is strictly blocking — do not guess, do not assume.
- Be specific. Vague stories are not acceptable.
- Respect ALL limits in the template. Do not exceed them.

Template (return ONLY this JSON, no markdown, no extra text):
{
  "problem_statement": "1-2 sentences max. What problem does this solve and for whom.",

  "user_stories": [
    // MAX 5 stories. Each story must be independently testable.
    {
      "as_a": "specific role (not 'user')",
      "i_want": "one concrete action or feature",
      "so_that": "one measurable benefit",
      "acceptance_criteria": [
        // MAX 3 criteria per story. Each must be verifiable.
        { "given": "context", "when": "action", "then": "observable result" }
      ]
    }
  ],

  "out_of_scope": [
    // MAX 5 items. Only what might be confused as in-scope.
    "string"
  ],

  "open_questions": [
    // Only strictly blocking questions — omit if answerable from context.
    // List ALL blocking questions here — do not defer any to future refinements.
    // Use a string for open-ended questions.
    // Use an object with options when the answer is a clear choice:
    "open ended question?",
    { "question": "Which option?", "options": ["Option A", "Option B", "Option C"] }
  ],

  "impacted_repos": [
    // One entry per repo. MAX 5.
    { "repo": "repo-name", "rationale": "1 sentence citing real code or structure", "estimated_effort": "low|medium|high" }
  ],

  "answered_questions": [
    // Include ONLY if there were checkbox answers or team comments above.
    // One entry per question that was answered — map it to the answer used.
    { "question": "the original question text", "answer": "the answer that was used in this PRD" }
  ]
}`
}

function buildTechnicalPrompt(task: TaskMeta, contextSections: string): string {
  return `Generate a Technical PRD for each listed repo. Follow the template exactly — no extra fields, no exceeding limits.

Task:
Title: ${task.title}
Description: ${task.description}
Repos: ${task.repos.join(', ')}
${buildCheckboxSection(task.checkboxAnswers)}${buildCommentsSection(task.comments)}
Repo contexts:
${contextSections || 'No repo context provided.'}

Rules:
- All file paths must exist in the directory structure shown. Do not invent paths.
- If a path is uncertain, add it to open_questions — do not guess.
- Identify ALL blocking open_questions upfront in this pass — do not defer questions to future refinements.
- Test scenarios must be concrete BDD, not vague.
- api_contract: omit entirely if no HTTP endpoint is added or changed.
- data_model_changes: null if none.
- Respect ALL limits in the template. Do not exceed them.

Template (return ONLY this JSON, no markdown, no extra text):
{
  "<repo_name>": {
    "repo": "repo-name",

    "files_to_modify": [
      // MAX 8 files. Only files that need to change.
      { "path": "exact/relative/path", "change_type": "create|modify|delete", "description": "1 sentence" }
    ],

    "api_contract": {
      // Omit this field entirely if no endpoint changes.
      "endpoint": "/path", "method": "GET|POST|PUT|DELETE|PATCH",
      "request_schema": {}, "response_schema": {}
    },

    "data_model_changes": "1-2 sentences or null",

    "test_scenarios": [
      // MAX 5 scenarios. BDD only — Given/When/Then must be concrete and verifiable.
      { "scenario": "name", "given": "context", "when": "action", "then": "result" }
    ],

    "dependencies": [
      // MAX 3. Only hard dependencies on other repos.
      { "repo": "repo-name", "what": "1 sentence" }
    ],

    "open_questions": [
      // Only strictly blocking — omit if answerable from context.
      // List ALL blocking questions here — do not defer any to future refinements.
      "open ended question?",
      { "question": "Which option?", "options": ["Option A", "Option B", "Option C"] }
    ],

    "answered_questions": [
      // Include ONLY if there were checkbox answers or team comments above.
      { "question": "the original question text", "answer": "the answer that was used in this PRD" }
    ]
  }
}`
}

function buildImplementPrompt(task: TaskMeta, prdJson: string, ctx: RepoContext): string {
  let repoPrd = ''
  try {
    const allPrds = JSON.parse(prdJson)
    const rd = allPrds[ctx.name]
    if (rd) repoPrd = JSON.stringify(rd, null, 2)
  } catch {
    repoPrd = prdJson
  }

  const repo = `${task.owner ?? 'la-haus'}/${task.repoName ?? ctx.name}`
  const issueNumber = task.issueNumber ?? ''

  const checkboxSnippet = issueNumber
    ? `After completing each file or test scenario, check its checkbox in the GitHub issue:
\`\`\`bash
# Read current body
gh issue view ${issueNumber} --repo ${repo} --json body -q '.body' > /tmp/issue_body.md
# Edit /tmp/issue_body.md — change "- [ ]" to "- [x]" for the completed item
gh issue edit ${issueNumber} --repo ${repo} --body-file /tmp/issue_body.md
\`\`\``
    : ''

  const inReviewSnippet = (task.projectId && task.itemId && task.statusFieldId && task.inReviewOptionId)
    ? `When the PR is open and all checkboxes are checked, move the issue to **In Review**:
\`\`\`bash
gh api graphql -f query='mutation {
  updateProjectV2ItemFieldValue(input: {
    projectId: "${task.projectId}"
    itemId: "${task.itemId}"
    fieldId: "${task.statusFieldId}"
    value: { singleSelectOptionId: "${task.inReviewOptionId}" }
  }) { projectV2Item { id } }
}'
\`\`\``
    : ''

  return `Implement this GitHub issue: https://github.com/${repo}/issues/${issueNumber}

Rules:
1. Read CLAUDE.md before anything else — follow its conventions strictly.
2. Use sub-agents and skills in .claude/ where appropriate (/qa for tests, /backend or /frontend for implementation).
3. Read every file listed in "Files to Modify" before touching it.
4. ${checkboxSnippet || 'Check each checkbox in the issue as you complete it.'}
5. Write and pass all tests in "Test Scenarios" — check their checkboxes when done.
6. Run lint and tests before committing.
7. Commit with a conventional commit message referencing #${issueNumber}.
8. Open a PR referencing this issue.
${inReviewSnippet ? `9. ${inReviewSnippet}` : ''}

Do not implement open_questions — add TODO comments instead.`
}

function buildTechnicalDecomposePrompt(task: TaskMeta, functionalPrdMarkdown: string, contextSections: string): string {
  return `Decompose this approved Functional PRD into technical sub-tasks, one per PR.

Functional task: ${task.title}
Repos: ${task.repos.join(', ')}

Functional PRD:
${functionalPrdMarkdown}

Repo contexts:
${contextSections || 'No repo context provided.'}

Rules:
- Each sub-task must fit in a single PR: focused, independently mergeable, single responsibility.
- One sub-task per logical unit of work. Split by repo if changes are independent; keep together if they must ship atomically.
- Title must follow conventional commits: feat(scope): description
- All file paths must exist in the directory structure shown. Do not invent paths.
- CRITICAL: Sub-tasks will be implemented independently by separate agents with no shared context. You MUST pre-decide all cross-cutting concerns NOW: API contracts, shared types, field names, endpoint paths, DB schema. Do NOT leave inter-task decisions as open_questions — decide them here and document them in each relevant sub-task.
- open_questions are ONLY for things unknown to you right now (business rules, external constraints). Never ask something that another sub-task in this list will decide.
- Use the dependencies field to declare what one sub-task needs from another and what the agreed contract is.
- api_contract: omit entirely if no HTTP endpoint is added or changed.
- data_model_changes: null if none.
- Test scenarios must be concrete BDD — Given/When/Then must be specific and verifiable.

Return ONLY a JSON array, no markdown, no extra text:
[
  {
    "title": "feat(scope): description",
    "repo": "exact-repo-name",
    "description": "1-2 sentences: what this PR does and why",
    "files_to_modify": [
      { "path": "exact/relative/path", "change_type": "create|modify|delete", "description": "1 sentence" }
    ],
    "api_contract": {
      "endpoint": "/path", "method": "GET|POST|PUT|DELETE|PATCH",
      "request_schema": {}, "response_schema": {}
    },
    "data_model_changes": "1-2 sentences or null",
    "test_scenarios": [
      { "scenario": "name", "given": "context", "when": "action", "then": "result" }
    ],
    "dependencies": [
      { "repo": "repo-name", "what": "1 sentence — what this sub-task needs from that repo" }
    ],
    "open_questions": [
      "open ended question?",
      { "question": "Which option?", "options": ["Option A", "Option B"] }
    ]
  }
]`
}
