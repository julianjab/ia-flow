// POST /api/sessions/complete — called by async agents (tmux/iterm) when they finish
// Handles both refinement and implementation completion
import { Hono } from 'hono'
import { getProjectMeta, updateIssueBody, updateItemStatus, addIssueComment } from '../github/project.js'
import { prdJsonToMarkdown, buildRefinedBody } from '../issue-managers/github/prd-formatter.js'
import { createLogger } from '../logger.js'
import type { StepType } from '../providers/index.js'

const log = createLogger('sessions')

export interface SessionCompletePayload {
  step: StepType
  issueId: string
  issueNumber: number
  repoName: string
  itemId: string
  projectId: string
  // Refinement fields
  prdJson?: string
  issueBody?: string       // current body needed to build refined body
  taskType?: string
  // Implementation fields
  summary?: string
  prUrl?: string
  branchName?: string
}

export function createSessionsRouter(projectUrl: string) {
  const router = new Hono()

  router.post('/complete', async (c) => {
    let payload: SessionCompletePayload
    try {
      payload = await c.req.json<SessionCompletePayload>()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    const { step, issueId, issueNumber, itemId, projectId } = payload
    if (!step || !issueId || !itemId || !projectId) {
      return c.json({ error: 'Missing required fields: step, issueId, itemId, projectId' }, 400)
    }

    log.info({ step, issue: issueNumber }, 'Session complete callback received')

    // Run async so we can return 200 immediately
    handleComplete(payload, projectUrl).catch((e) =>
      log.error({ err: e, step, issue: issueNumber }, 'Session complete handler failed'),
    )

    return c.json({ ok: true })
  })

  return router
}

async function handleComplete(payload: SessionCompletePayload, projectUrl: string): Promise<void> {
  const { step, issueId, issueNumber, itemId, projectId } = payload

  // Load project meta to get status field
  const meta = await getProjectMeta(projectUrl)
  const statusField = meta.fields['Status']

  if (step === 'refine-functional' || step === 'refine-technical') {
    if (!payload.prdJson) {
      log.warn({ issue: issueNumber }, 'Refinement complete but no prdJson provided')
      return
    }

    const taskType = payload.taskType ?? (step === 'refine-technical' ? 'technical' : 'functional')
    const prdMarkdown = prdJsonToMarkdown(payload.prdJson, taskType)
    const base = (payload.issueBody ?? '').split('\n\n---\n\n')[0].trim()
    const newBody = buildRefinedBody(base, prdMarkdown)

    await updateIssueBody(issueId, newBody)
    if (statusField) await updateItemStatus(projectId, itemId, statusField, 'Refined')

    log.info({ issue: issueNumber }, 'Issue refined via agent callback')
  }

  if (step === 'implement') {
    const lines = ['## ✅ Implementación completada por agente']
    if (payload.summary) lines.push('', payload.summary)
    if (payload.prUrl) lines.push('', `**PR:** ${payload.prUrl}`)
    if (payload.branchName) lines.push('', `**Branch:** \`${payload.branchName}\``)

    await addIssueComment(issueId, lines.join('\n'))
    if (statusField) await updateItemStatus(projectId, itemId, statusField, 'In Review')

    log.info({ issue: issueNumber, prUrl: payload.prUrl }, 'Issue moved to In Review via agent callback')
  }
}
