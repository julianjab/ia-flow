// GitHub Projects daemon — polls for status changes and routes to agents
import { getProjectMeta, listProjectItems, updateItemStatus, updateIssueBody, addIssueComment, upsertValidationComment, clearValidationComment, fetchIssueComments, markCommentsAsUsed, createIssue, addProjectItem, setProjectTextField, addSubIssue, addBlockedBy, getBlockingIssues } from './github/project.js'
import { gatherContextsForRepos } from './agents/context-gatherer.js'
import { orchestrateRefine, orchestrateImplement, orchestrateTechnicalDecompose } from './agents/orchestrator.js'
import { getRepoPaths, clearRepoCache, resolveGithubRepo } from './repos.js'
import { createLogger } from './logger.js'
import type { ProjectMeta, ProjectItem } from './github/project.js'

const log = createLogger('daemon')

const POLL_INTERVAL_MS = 30_000
const processing = new Set<string>()  // item ids currently being processed in this run

type BroadcastFn = (msg: object) => void
let broadcast: BroadcastFn = () => {}

export function setGithubBroadcast(fn: BroadcastFn) {
  broadcast = fn
}

// ─── Issue body helpers ───────────────────────────────────────────────────

export function buildRefinedBody(original: string, prdMarkdown: string): string {
  return `${original.trim()}\n\n---\n\n${prdMarkdown}`
}

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'

function renderQuestion(q: any, indent = ''): string {
  if (typeof q === 'string') return `${indent}- ❓ ${q}`
  // Multiple choice
  const opts = (q.options ?? [])
    .map((opt: string, i: number) => `${indent}  - [ ] ${LETTERS[i]}) ${opt}`)
    .join('\n')
  return `${indent}- ❓ ${q.question}\n${opts}`
}

// Parse checkbox answers from a rendered PRD body
// Returns: [{ question, selected: ["option text"] }]
export function parseCheckboxAnswers(body: string): Array<{ question: string; selected: string[] }> {
  const results: Array<{ question: string; selected: string[] }> = []
  const lines = body.split('\n')

  let currentQuestion: string | null = null
  let selected: string[] = []

  for (const line of lines) {
    const questionMatch = line.match(/[-*]\s+❓\s+(.+)/)
    if (questionMatch) {
      if (currentQuestion && selected.length) results.push({ question: currentQuestion, selected })
      currentQuestion = questionMatch[1].trim()
      selected = []
      continue
    }
    if (currentQuestion) {
      const checkedMatch = line.match(/\s*-\s+\[x\]\s+[a-z]\)\s+(.+)/i)
      if (checkedMatch) {
        selected.push(checkedMatch[1].trim())
        continue
      }
      // Unchecked option — still part of this question
      const uncheckedMatch = line.match(/\s*-\s+\[\s+\]\s+[a-z]\)\s+(.+)/i)
      if (uncheckedMatch) continue
      // Line doesn't belong to this question anymore
      if (selected.length) results.push({ question: currentQuestion, selected })
      currentQuestion = null
      selected = []
    }
  }
  if (currentQuestion && selected.length) results.push({ question: currentQuestion, selected })
  return results
}

export function prdJsonToMarkdown(prdJson: string, taskType: string): string {
  try {
    const data = JSON.parse(prdJson)

    if (taskType.toLowerCase() !== 'technical') {
      // Functional PRD
      const p = data
      const stories = (p.user_stories ?? [])
        .map((s: any) => {
          const criteria = (s.acceptance_criteria ?? [])
            .map((c: any) => `  - **Given** ${c.given} **When** ${c.when} **Then** ${c.then}`)
            .join('\n')
          return `#### As a ${s.as_a}, I want ${s.i_want}, so that ${s.so_that}\n${criteria}`
        })
        .join('\n\n')

      const repos = (p.impacted_repos ?? [])
        .map((r: any) => `- **${r.repo}** (${r.estimated_effort}): ${r.rationale}`)
        .join('\n')

      const questions = (p.open_questions ?? []).map((q: any) => renderQuestion(q)).join('\n\n')
      const oos = (p.out_of_scope ?? []).map((s: string) => `- ${s}`).join('\n')
      const answered = (p.answered_questions ?? [])
        .map((a: any) => `- **${a.question}** → ${a.answer}`)
        .join('\n')

      return [
        '## 📋 Functional PRD',
        '',
        `### Problem Statement\n${p.problem_statement}`,
        '',
        '### User Stories',
        stories,
        '',
        '### Impacted Repos',
        repos,
        '',
        '### Out of Scope',
        oos,
        '',
        questions ? `### ❓ Open Questions\n${questions}` : '',
        answered ? `### 💬 Preguntas Respondidas\n${answered}` : '',
      ].filter(Boolean).join('\n')
    }

    // Technical PRD — one section per repo
    const sections: string[] = ['## 🔧 Technical PRD']
    for (const [repo, rd] of Object.entries(data) as [string, any][]) {
      const files = (rd.files_to_modify ?? [])
        .map((f: any) => `  - \`${f.path}\` (${f.change_type}): ${f.description}`)
        .join('\n')
      const scenarios = (rd.test_scenarios ?? [])
        .map((t: any) => `  - **${t.scenario}**: Given ${t.given} → When ${t.when} → Then ${t.then}`)
        .join('\n')
      const deps = (rd.dependencies ?? []).map((d: any) => `  - ${d.repo}: ${d.what}`).join('\n')
      const questions = (rd.open_questions ?? []).map((q: any) => renderQuestion(q, '  ')).join('\n\n')
      const api = rd.api_contract
        ? `\n**API Contract:** \`${rd.api_contract.method} ${rd.api_contract.endpoint}\``
        : ''

      sections.push(
        `\n### ${repo}${api}`,
        files ? `**Files to touch:**\n${files}` : '',
        rd.data_model_changes ? `**Data model changes:** ${rd.data_model_changes}` : '',
        scenarios ? `**Test scenarios:**\n${scenarios}` : '',
        deps ? `**Dependencies:**\n${deps}` : '',
        questions ? `**Open questions:**\n${questions}` : '',
      )
    }
    return sections.filter(Boolean).join('\n')
  } catch {
    return `## PRD\n\`\`\`json\n${prdJson}\n\`\`\``
  }
}

// ─── Process a single Queue item ─────────────────────────────────────────

// ─── Validation ───────────────────────────────────────────────────────────

interface ValidationResult {
  ok: boolean
  missing: string[]
}

function validateItem(item: ProjectItem): ValidationResult {
  const missing: string[] = []

  const repos = item.repos.split(',').map((r) => r.trim()).filter(Boolean)
  if (repos.length === 0) {
    missing.push('**Repos** — agrega los repos afectados separados por coma (ej: `subscriptions, buyer-web-front`)')
  }

  if (!item.type) {
    missing.push('**Task Type** — selecciona el tipo: `functional`, `technical`, `bug`, `spike` o `hotfix`')
  }

  return { ok: missing.length === 0, missing }
}

async function processQueueItem(item: ProjectItem, meta: ProjectMeta): Promise<void> {
  if (processing.has(item.id)) {
    log.debug({ issue: item.issueNumber }, 'Skipping — already in-flight')
    return
  }

  const validation = validateItem(item)
  if (!validation.ok) {
    const reasons = validation.missing.map((m) => m.replace(/\*\*/g, '').replace(/`[^`]+`/g, (s) => s.slice(1, -1)))
    log.warn({ issue: item.issueNumber, title: item.issueTitle, missing: reasons }, 'Skipping — required fields missing')
    const lines = validation.missing.map((m) => `- ${m}`).join('\n')
    await upsertValidationComment(
      item.issueId,
      `## ⏸️ Este issue está en Queue pero no puede ser procesado\n\nFaltan los siguientes campos:\n\n${lines}\n\n_Este comentario se actualiza automáticamente en cada revisión._`,
    )
    return
  }

  await clearValidationComment(item.issueId)

  processing.add(item.id)
  const statusField = meta.fields['Status']
  const itemLog = log.child({ issue: item.issueNumber, title: item.issueTitle })

  // Move to Refining before starting — if we crash mid-run the item won't re-enter Queue
  if (statusField) await updateItemStatus(meta.projectId, item.id, statusField, 'Refining')
  itemLog.info('Processing queue item → Refining')
  broadcast({ type: 'github:processing', issueNumber: item.issueNumber, title: item.issueTitle })

  try {
    const cleanBase = item.issueBody.split('\n\n---\n\n')[0].trim()

    const repoNames = item.repos.split(',').map((r) => r.trim()).filter(Boolean)
    if (repoNames.length === 0) throw new Error('No repos specified in the Repos field.')

    const commentItems = await fetchIssueComments(item.issueId)
    const comments = commentItems.map((c) => c.body)
    if (comments.length) itemLog.info({ count: comments.length }, 'Including human comments')

    itemLog.info({ repos: repoNames }, 'Gathering repo contexts')
    clearRepoCache()
    const repoEntries = await getRepoPaths(repoNames)
    if (repoEntries.length === 0) {
      throw new Error(`Repos not found: ${repoNames.join(', ')}. Check EXTRA_REPOS in .env.`)
    }

    const contexts = await gatherContextsForRepos(repoEntries)
    const checkboxAnswers = parseCheckboxAnswers(item.issueBody)

    const { prdJson } = await orchestrateRefine(
      {
        title: item.issueTitle,
        description: cleanBase,
        type: item.type || 'functional',
        repos: repoNames,
        comments: comments.length ? comments : undefined,
        checkboxAnswers: checkboxAnswers.length ? checkboxAnswers : undefined,
        issueId: item.issueId,
        issueNumber: item.issueNumber,
        issueBody: cleanBase,
        repoName: item.repoName,
        itemId: item.id,
        projectId: meta.projectId,
      },
      contexts,
    )

    const prdMarkdown = prdJsonToMarkdown(prdJson, item.type || 'functional')
    const newBody = buildRefinedBody(cleanBase, prdMarkdown)
    await updateIssueBody(item.issueId, newBody)
    if (statusField) await updateItemStatus(meta.projectId, item.id, statusField, 'Refined')

    itemLog.info('Item refined → Refined')
    broadcast({ type: 'github:refined', issueNumber: item.issueNumber, title: item.issueTitle })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    itemLog.error({ err }, 'Refinement failed — moving to Backlog')
    try {
      await addIssueComment(item.issueId, `## ⚠️ ia-flow refinement error\n\n\`\`\`\n${msg}\n\`\`\`\n\nRevisa el error y mueve a **Queue** para reintentar.`)
      if (statusField) await updateItemStatus(meta.projectId, item.id, statusField, 'Backlog')
    } catch (reportErr) {
      log.error({ err: reportErr }, 'Could not report error to GitHub')
    }
    broadcast({ type: 'github:error', issueNumber: item.issueNumber, error: msg })
  } finally {
    processing.delete(item.id)
  }
}

// ─── Process an Approved functional item → create technical sub-issues ───

async function processApprovedFunctionalItem(item: ProjectItem, meta: ProjectMeta): Promise<void> {
  if (processing.has(item.id)) return

  processing.add(item.id)
  const statusField = meta.fields['Status']
  const itemLog = log.child({ issue: item.issueNumber, title: item.issueTitle })

  // Move to Implementing before starting
  if (statusField) await updateItemStatus(meta.projectId, item.id, statusField, 'Implementing')
  itemLog.info('Decomposing functional PRD → Implementing')
  broadcast({ type: 'github:decomposing', issueNumber: item.issueNumber, title: item.issueTitle })

  try {
    const repoNames = item.repos.split(',').map((r) => r.trim()).filter(Boolean)
    clearRepoCache()
    const repoEntries = await getRepoPaths(repoNames)
    const contexts = await gatherContextsForRepos(repoEntries)

    // Extract the functional PRD markdown (everything after the first ---)
    const functionalPrd = item.issueBody.split('\n\n---\n\n').slice(1).join('\n\n---\n\n').trim()

    const subTasks = await orchestrateTechnicalDecompose(
      {
        title: item.issueTitle,
        description: item.issueBody,
        type: item.type,
        repos: repoNames,
        issueId: item.issueId,
        issueNumber: item.issueNumber,
        repoName: item.repoName,
        itemId: item.id,
        projectId: meta.projectId,
      },
      functionalPrd,
      contexts,
    )

    itemLog.info({ count: subTasks.length }, 'Technical sub-tasks generated')

    const taskTypeField = meta.fields['Task Type']
    const reposField = meta.fields['Repos']
    const createdLinks: string[] = []

    // Map subTask → created issue for dependency linking after all issues exist
    const createdMap = new Map<typeof subTasks[number], { id: string; number: number }>()

    const parentResolved = await resolveGithubRepo(item.repoName, meta.owner)

    for (const sub of subTasks) {
      const subBody = buildTechnicalSubIssueBody(sub, item.issueNumber)
      const { owner: subOwner, repo: subRepo } = await resolveGithubRepo(sub.repo, meta.owner)
      const created = await createIssue(subOwner, subRepo, sub.title, subBody)
      itemLog.info({ number: created.number, owner: subOwner, repo: subRepo, localRepo: sub.repo, title: sub.title }, 'Created technical sub-issue')

      createdMap.set(sub, { id: created.id, number: created.number })

      // Add to project and set fields — Refined directly, no re-refinement needed
      const { itemId: subItemId } = await addProjectItem(meta.projectId, created.id)

      if (statusField) await updateItemStatus(meta.projectId, subItemId, statusField, 'Refined')
      if (taskTypeField) await updateItemStatus(meta.projectId, subItemId, taskTypeField, 'Technical')
      if (reposField) await setProjectTextField(meta.projectId, subItemId, reposField, sub.repo)

      // Link as native GitHub sub-issue
      await addSubIssue(parentResolved.owner, parentResolved.repo, item.issueNumber, created.numericId)

      createdLinks.push(`- #${created.number} — ${sub.title}`)
    }

    // Wire blocked-by relationships — match dependency by repo name
    for (const sub of subTasks) {
      const blockedIssue = createdMap.get(sub)
      if (!blockedIssue || !sub.dependencies.length) continue

      for (const dep of sub.dependencies) {
        const blockingSubTask = subTasks.find((s) => s !== sub && s.repo === dep.repo)
        const blockingIssue = blockingSubTask ? createdMap.get(blockingSubTask) : undefined
        if (!blockingIssue) continue

        try {
          await addBlockedBy(blockedIssue.id, blockingIssue.id)
          itemLog.info({ blocked: blockedIssue.number, blocking: blockingIssue.number }, 'Linked blocked-by dependency')
        } catch (e) {
          itemLog.warn({ err: e }, `Could not link blocked-by #${blockedIssue.number} ← #${blockingIssue.number}`)
        }
      }
    }

    if (statusField) await updateItemStatus(meta.projectId, item.id, statusField, 'Implementing')
    itemLog.info('Functional issue moved to Implementing, sub-issues created as Refined')
    broadcast({ type: 'github:decomposed', issueNumber: item.issueNumber, subCount: subTasks.length })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    itemLog.error({ err }, 'Technical decomposition failed — moving back to Refined')
    try {
      await addIssueComment(item.issueId, `## ⚠️ Technical decomposition error\n\n\`\`\`\n${msg}\n\`\`\`\n\nRevisa el error y mueve a **Approved** para reintentar.`)
      if (statusField) await updateItemStatus(meta.projectId, item.id, statusField, 'Refined')
    } catch (reportErr) {
      log.error({ err: reportErr }, 'Could not report error to GitHub')
    }
    broadcast({ type: 'github:error', issueNumber: item.issueNumber, error: msg })
  } finally {
    processing.delete(item.id)
  }
}

function buildTechnicalSubIssueBody(sub: import('./agents/orchestrator.js').TechnicalSubTask, parentNumber: number): string {
  const files = sub.files_to_modify
    .map((f) => `- [ ] \`${f.path}\` (${f.change_type}): ${f.description}`)
    .join('\n')

  const scenarios = sub.test_scenarios
    .map((t) => `- [ ] **${t.scenario}**\n  - Given: ${t.given}\n  - When: ${t.when}\n  - Then: ${t.then}`)
    .join('\n')

  const deps = sub.dependencies.length
    ? `\n### Dependencies\n${sub.dependencies.map((d) => `- **${d.repo}**: ${d.what}`).join('\n')}`
    : ''

  const LETTERS = 'abcdefghijklmnopqrstuvwxyz'
  const questions = sub.open_questions.length
    ? `\n### ❓ Open Questions\n${sub.open_questions.map((q) => {
        if (typeof q === 'string') return `- ❓ ${q}`
        const opts = q.options.map((o, i) => `  - [ ] ${LETTERS[i]}) ${o}`).join('\n')
        return `- ❓ ${q.question}\n${opts}`
      }).join('\n\n')}`
    : ''

  const api = sub.api_contract
    ? `\n### API Contract\n\`${sub.api_contract.method} ${sub.api_contract.endpoint}\``
    : ''

  const dataModel = sub.data_model_changes
    ? `\n### Data Model Changes\n${sub.data_model_changes}`
    : ''

  return `> Parent: #${parentNumber}

${sub.description}
${api}${dataModel}

### Files to Modify
${files}

### Test Scenarios
${scenarios}
${deps}${questions}

<!-- ia-flow:technical -->`
}

// ─── Process an Approved technical item → trigger implementation ──────────

async function processApprovedTechnicalItem(item: ProjectItem, meta: ProjectMeta): Promise<void> {
  if (processing.has(item.id)) return

  processing.add(item.id)
  const statusField = meta.fields['Status']
  const itemLog = log.child({ issue: item.issueNumber, title: item.issueTitle })

  // Check for open blocking dependencies before implementing
  try {
    const parentResolved = await resolveGithubRepo(item.repoName, meta.owner)
    const blockers = await getBlockingIssues(parentResolved.owner, parentResolved.repo, item.issueNumber)
    const openBlockers = blockers.filter((b) => b.state === 'open')
    if (openBlockers.length > 0) {
      const list = openBlockers.map((b) => `- #${b.number} — ${b.title}`).join('\n')
      itemLog.warn({ blockers: openBlockers.map((b) => b.number) }, 'Issue has open blockers — moving to Blocked')
      if (statusField) await updateItemStatus(meta.projectId, item.id, statusField, 'Blocked')
      await addIssueComment(item.issueId, `## 🚫 Bloqueado por dependencias sin completar\n\n${list}\n\nCierra los issues bloqueantes y mueve a **Approved** para reintentar.`)
      processing.delete(item.id)
      return
    }
  } catch (e) {
    itemLog.warn({ err: e }, 'Could not check blocking issues — proceeding anyway')
  }

  // Move to Implementing before starting
  if (statusField) await updateItemStatus(meta.projectId, item.id, statusField, 'Implementing')
  itemLog.info('Starting implementation → Implementing')
  broadcast({ type: 'github:implementing', issueNumber: item.issueNumber, title: item.issueTitle })

  try {
    const repoNames = item.repos.split(',').map((r) => r.trim()).filter(Boolean)
    clearRepoCache()
    const repoEntries = await getRepoPaths(repoNames)
    const contexts = await gatherContextsForRepos(repoEntries)

    const prdJson = item.issueBody.split('\n\n---\n\n').slice(1).join('\n\n---\n\n').trim() || item.issueBody

    const inReviewOptionId = statusField?.options?.find((o) => o.name.toLowerCase() === 'in review')?.id

    const outputs = await orchestrateImplement(
      {
        title: item.issueTitle,
        description: item.issueBody,
        type: item.type || 'technical',
        repos: repoNames,
        issueId: item.issueId,
        issueNumber: item.issueNumber,
        repoName: item.repoName,
        owner: meta.owner,
        itemId: item.id,
        projectId: meta.projectId,
        statusFieldId: statusField?.id,
        inReviewOptionId,
      },
      prdJson,
      contexts,
    )

    const summary = outputs
      .map((o, i) => `**${repoNames[i] ?? 'repo'}**: ${o.tmuxSession ? `Session \`${o.attachCmd}\`` : 'Completed'}`)
      .join('\n')

    await addIssueComment(item.issueId, `## 🚀 Implementation started\n\n${summary}`)
    itemLog.info({ sessions: outputs.map((o) => o.tmuxSession).filter(Boolean) }, 'Implementation started')
    broadcast({ type: 'github:implementing-started', issueNumber: item.issueNumber })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    itemLog.error({ err }, 'Implementation failed — moving back to Refined')
    try {
      await addIssueComment(item.issueId, `## ⚠️ Implementation error\n\n\`\`\`\n${msg}\n\`\`\`\n\nRevisa el error y mueve a **Approved** para reintentar.`)
      if (statusField) await updateItemStatus(meta.projectId, item.id, statusField, 'Refined')
    } catch (reportErr) {
      log.error({ err: reportErr }, 'Could not report error to GitHub')
    }
    broadcast({ type: 'github:error', issueNumber: item.issueNumber, error: msg })
  } finally {
    processing.delete(item.id)
  }
}

// ─── Poll loop ────────────────────────────────────────────────────────────

export function startGithubDaemon(): NodeJS.Timeout {
  const projectUrl = Bun.env.GITHUB_PROJECT_URL
  if (!projectUrl) {
    log.warn('GITHUB_PROJECT_URL not set — daemon disabled')
    return setInterval(() => {}, 60_000)
  }

  log.info({ url: projectUrl, intervalSec: POLL_INTERVAL_MS / 1000 }, 'Daemon started')

  let meta: ProjectMeta | null = null

  async function poll() {
    try {
      if (!meta) {
        meta = await getProjectMeta(projectUrl)
        log.info({ projectId: meta.projectId, fields: Object.keys(meta.fields) }, 'Project loaded')
      }

      const queued = await listProjectItems(meta.projectId, meta.fields, 'Queue')
      if (queued.length) log.debug({ count: queued.length }, 'Queue items found')
      for (const item of queued) {
        processQueueItem(item, meta!).catch((e) => log.error({ err: e, issue: item.issueNumber }, 'processQueueItem threw'))
      }

      const approved = await listProjectItems(meta.projectId, meta.fields, 'Approved')
      if (approved.length) log.debug({ count: approved.length }, 'Approved items found')
      for (const item of approved) {
        if (item.type.toLowerCase() === 'functional') {
          processApprovedFunctionalItem(item, meta!).catch((e) => log.error({ err: e, issue: item.issueNumber }, 'processApprovedFunctionalItem threw'))
        } else {
          processApprovedTechnicalItem(item, meta!).catch((e) => log.error({ err: e, issue: item.issueNumber }, 'processApprovedTechnicalItem threw'))
        }
      }
    } catch (err) {
      log.error({ err }, 'Poll error — will retry next interval')
      meta = null
    }
  }

  poll().catch((e) => log.error({ err: e }, 'Initial poll failed'))
  return setInterval(() => poll().catch((e) => log.error({ err: e }, 'Poll failed')), POLL_INTERVAL_MS)
}
