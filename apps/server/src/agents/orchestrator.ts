// Orchestrator — builds prompts per step and routes to the configured provider
import { dirname, basename, join } from 'node:path'
import type { RepoContext, RepoWorkflow } from '@ia-flow/shared'
import { getStepProvider, resolveStepSettings, loadProviderConfig } from '../providers/index.js'
import type { StepOutput, StepType } from '../providers/index.js'
import { resolveGithubRemote, slugify } from '../providers/terminal-provider-base.js'
import { renderPhasePrompt, substituteVars } from '../prompts/render.js'
import { DEFAULT_TECHNICAL_DECOMPOSE_PROMPT } from '../prompts/defaults.js'

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

  const contextSections = buildContextSections(contexts)

  // Load config ONCE here and resolve the prompt BEFORE provider.run so an
  // in-flight run captures the prompt snapshot even if the config file is
  // rewritten mid-run.
  const config = await loadProviderConfig()
  const { settings } = resolveStepSettings(step, config)
  const lang = settings.responseLanguage ?? 'english'

  const vars = buildBaseVars(task, contextSections, lang)
  const prompt = renderPhasePrompt(step, config, vars)

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

  // Snapshot config once per orchestration so all per-repo runs share the
  // same resolved prompt (mid-run config edits do not leak in).
  const config = await loadProviderConfig()
  const { settings } = resolveStepSettings('implement', config)
  const lang = settings.responseLanguage ?? 'english'

  const daemonUrl = `http://localhost:${Bun.env.PORT ?? 3001}`

  for (const ctx of contexts) {
    const githubRemote = ctx.path ? await resolveGithubRemote(ctx.path) : null

    const repoMapping = config.repoMappings?.[ctx.name]
    const workflow = (repoMapping && typeof repoMapping === 'object' ? repoMapping.workflow : undefined) ?? 'branch'

    const vars = buildImplementVars(task, prdJson, ctx, githubRemote, workflow, lang)
    const prompt = renderPhasePrompt('implement', config, vars)
    const output = await provider.run({
      step: 'implement',
      taskTitle: task.title,
      taskDescription: task.description,
      taskType: task.type,
      repos: task.repos,
      contexts: [ctx],
      prompt,
      cwd: ctx.path,
      workflow,
      issueId: task.issueId,
      issueNumber: task.issueNumber,
      repoName: task.repoName,
      owner: task.owner,
      itemId: task.itemId,
      projectId: task.projectId,
      statusFieldId: task.statusFieldId,
      inReviewOptionId: task.inReviewOptionId,
      githubRemote: githubRemote ?? undefined,
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

  const contextSections = buildContextSections(contexts)

  const config = await loadProviderConfig()
  const { settings } = resolveStepSettings('refine-technical', config)
  const lang = settings.responseLanguage ?? 'english'

  // Decompose has its own dedicated template (not a StepType key) so we do
  // not go through renderPhasePrompt here.
  const vars = {
    ...buildBaseVars(task, contextSections, lang),
    functional_prd_markdown: functionalPrdMarkdown,
  }
  const prompt = substituteVars(DEFAULT_TECHNICAL_DECOMPOSE_PROMPT, vars)
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

// ─── Prompt variable helpers ──────────────────────────────────────────────

function buildContextSections(contexts: RepoContext[]): string {
  return contexts
    .map((ctx) => {
      const parts: string[] = [`### Repo: ${ctx.name} (${ctx.type})`]
      if (ctx.claude_md) parts.push(`CLAUDE.md:\n${ctx.claude_md.slice(0, 1500)}`)
      if (ctx.manifest) parts.push(`Manifest:\n${ctx.manifest.slice(0, 800)}`)
      if (ctx.directory_tree) parts.push(`Structure:\n${ctx.directory_tree.slice(0, 800)}`)
      return parts.join('\n\n')
    })
    .join('\n\n---\n\n')
}

function buildCommentsSection(comments: string[] | undefined): string {
  if (!comments?.length) return ''
  return `\nTeam answers to open questions (via comments):\n${comments.map((c, i) => `[${i + 1}] ${c}`).join('\n\n')}\n`
}

function buildCheckboxSection(answers: Array<{ question: string; selected: string[] }> | undefined): string {
  if (!answers?.length) return ''
  const lines = answers.map((a) => `- "${a.question}" → selected: ${a.selected.join(', ')}`)
  return `\nQuestions answered via checkboxes in the issue body (do NOT re-ask these):\n${lines.join('\n')}\n`
}

function buildBaseVars(task: TaskMeta, contextSections: string, lang: string): Record<string, string> {
  return {
    task_title: task.title,
    task_description: task.description,
    task_type: task.type,
    repos: task.repos.join(', '),
    checkbox_answers: buildCheckboxSection(task.checkboxAnswers),
    comments: buildCommentsSection(task.comments),
    contexts: contextSections || 'No repo context provided.',
    response_language: lang,
  }
}

function buildGitContext(workflow: RepoWorkflow, repoPath: string | undefined, taskTitle: string): string {
  const slug = slugify(taskTitle)
  const branch = `feat/${slug}`
  if (workflow === 'main') {
    return `Workflow: main — you are on the default branch. Commit directly, do NOT create new branches.`
  }
  if (workflow === 'worktree' && repoPath) {
    const wtPath = join(dirname(repoPath), `${basename(repoPath)}-${slug}`)
    return `Workflow: worktree — you are in a dedicated worktree at \`${wtPath}\` on branch \`${branch}\`. Do NOT create new branches. Commit and push from this directory.`
  }
  return `Workflow: branch — you are on branch \`${branch}\` (already checked out). Do NOT create new branches. Commit and push from this branch.`
}

function buildImplementVars(
  task: TaskMeta,
  prdJson: string,
  ctx: RepoContext,
  githubRemote: string | null,
  workflow: RepoWorkflow,
  lang: string,
): Record<string, string> {
  let repoPrd = ''
  try {
    const allPrds = JSON.parse(prdJson)
    const rd = allPrds[ctx.name]
    if (rd) repoPrd = JSON.stringify(rd, null, 2)
    else repoPrd = prdJson
  } catch {
    repoPrd = prdJson
  }

  const owner = task.owner ?? 'la-haus'
  const repoName = task.repoName ?? ctx.name
  const repoSlug = `${owner}/${repoName}`
  const issueNumber = task.issueNumber != null ? String(task.issueNumber) : ''

  const checkboxSnippet = issueNumber
    ? `After completing each file or test scenario, check its checkbox in the GitHub issue:
\`\`\`bash
# Read current body
gh issue view ${issueNumber} --repo ${repoSlug} --json body -q '.body' > /tmp/issue_body.md
# Edit /tmp/issue_body.md — change "- [ ]" to "- [x]" for the completed item
gh issue edit ${issueNumber} --repo ${repoSlug} --body-file /tmp/issue_body.md
\`\`\``
    : 'Check each checkbox in the issue as you complete it.'

  const inReviewSnippet = (task.projectId && task.itemId && task.statusFieldId && task.inReviewOptionId)
    ? `9. When the PR is open and all checkboxes are checked, move the issue to **In Review**:
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

  const prInstruction = workflow === 'main'
    ? `Push directly to the default branch. Do NOT open a PR — you committed directly to main.`
    : githubRemote
      ? `Open a PR on ${githubRemote} referencing this issue.`
      : `No GitHub remote detected — skip PR creation. Report the branch name when done.`

  // The issue body is: "<original description>\n\n---\n\n<prd markdown>".
  // Strip everything after the separator — the PRD is already in repo_prd below.
  const taskDescription = task.description.split('\n\n---\n\n')[0].trim()

  const issueUrl = issueNumber && githubRemote
    ? `https://github.com/${githubRemote}/issues/${issueNumber}`
    : ''

  return {
    task_title: task.title,
    task_description: taskDescription,
    task_type: task.type,
    repos: task.repos.join(', '),
    checkbox_answers: buildCheckboxSection(task.checkboxAnswers),
    comments: buildCommentsSection(task.comments),
    contexts: buildContextSections([ctx]),
    response_language: lang,
    issue_number: issueNumber,
    issue_url: issueUrl,
    repo: repoName,
    repo_name: repoName,
    github_remote: githubRemote ?? repoSlug,
    repo_prd: repoPrd,
    checkbox_snippet: checkboxSnippet,
    in_review_snippet: inReviewSnippet,
    pr_instruction: prInstruction,
    git_context: buildGitContext(workflow, ctx.path, task.title),
  }
}
