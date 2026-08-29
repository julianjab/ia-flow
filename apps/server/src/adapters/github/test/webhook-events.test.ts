import { describe, expect, it } from 'bun:test'
import {
  CI_FINISHED,
  PR_CLOSED,
  PR_MERGED,
  PR_OPENED,
  PR_REVIEW_SUBMITTED,
  PR_SYNCHRONIZED,
  type ScopeResolver,
  githubWebhookEvent,
  isBusEvent,
} from '../webhook-events.js'

const resolve: ScopeResolver = (owner, repo) =>
  owner === 'julianjab' && repo === 'ia-flow' ? { projectId: 'ia-flow', repoName: 'core' } : null

const repository = {
  name: 'ia-flow',
  owner: { login: 'julianjab' },
  full_name: 'julianjab/ia-flow',
}

function pr(over: Record<string, unknown> = {}) {
  return {
    number: 42,
    title: 'Arreglar el login',
    state: 'open',
    draft: false,
    additions: 640,
    user: { login: 'julianjab' },
    head: { ref: 'feat/login', sha: 'abc123' },
    base: { ref: 'main' },
    html_url: 'https://github.com/julianjab/ia-flow/pull/42',
    ...over,
  }
}

describe('isBusEvent', () => {
  it('acepta los cuatro que producen eventos, y nada más', () => {
    for (const e of ['pull_request', 'pull_request_review', 'check_suite', 'workflow_run']) {
      expect(isBusEvent(e)).toBe(true)
    }
    expect(isBusEvent('issues')).toBe(false)
    expect(isBusEvent('push')).toBe(false)
  })
})

describe('pull_request', () => {
  it('opened produce pr.opened con el scope resuelto', () => {
    const e = githubWebhookEvent(
      'pull_request',
      { action: 'opened', repository, pull_request: pr() },
      resolve,
    )
    expect(e?.type).toBe(PR_OPENED)
    expect(e?.scope).toEqual({ projectId: 'ia-flow', repos: ['core'], prNumber: 42 })
    expect(e?.source).toBe('github')
  })

  it('reopened cuenta como opened — para una regla es el mismo hecho', () => {
    const e = githubWebhookEvent(
      'pull_request',
      { action: 'reopened', repository, pull_request: pr() },
      resolve,
    )
    expect(e?.type).toBe(PR_OPENED)
  })

  it('synchronize produce su propio tipo', () => {
    const e = githubWebhookEvent(
      'pull_request',
      { action: 'synchronize', repository, pull_request: pr() },
      resolve,
    )
    expect(e?.type).toBe(PR_SYNCHRONIZED)
  })

  it('closed se parte en merged y closed según el flag', () => {
    // Dos hechos distintos con consecuencias distintas: obligar a cada regla a
    // condicionar sobre `merged` es la clase de detalle que se olvida.
    const merged = githubWebhookEvent(
      'pull_request',
      { action: 'closed', repository, pull_request: pr({ merged: true }) },
      resolve,
    )
    const closed = githubWebhookEvent(
      'pull_request',
      { action: 'closed', repository, pull_request: pr({ merged: false }) },
      resolve,
    )
    expect(merged?.type).toBe(PR_MERGED)
    expect(closed?.type).toBe(PR_CLOSED)
  })

  it('una acción que no interesa no produce evento', () => {
    expect(
      githubWebhookEvent(
        'pull_request',
        { action: 'labeled', repository, pull_request: pr() },
        resolve,
      ),
    ).toBeNull()
  })

  it('aplana los campos del PR con nombres condicionables', () => {
    const e = githubWebhookEvent(
      'pull_request',
      { action: 'opened', repository, pull_request: pr({ draft: true }) },
      resolve,
    )
    const payload = e?.payload as { pr: Record<string, unknown> }
    expect(payload.pr.isDraft).toBe(true)
    expect(payload.pr.additions).toBe(640)
    expect((payload.pr.head as { ref: string }).ref).toBe('feat/login')
  })

  it('un repo que ia-flow no conoce deja el evento sin scope', () => {
    // Fail-closed: sin projectId sólo lo ven las reglas globales, que es lo
    // correcto — no hay proyecto del que sacar config.
    const e = githubWebhookEvent(
      'pull_request',
      {
        action: 'opened',
        repository: { name: 'otro', owner: { login: 'ajeno' } },
        pull_request: pr(),
      },
      resolve,
    )
    expect(e?.scope.projectId).toBeUndefined()
    expect(e?.scope.prNumber).toBe(42)
  })

  it('el delivery id de GitHub es la identidad del evento', () => {
    // GitHub reintenta un delivery fallido con el MISMO id; sin esto un
    // reintento dispararía las reglas dos veces.
    const a = githubWebhookEvent(
      'pull_request',
      { action: 'opened', repository, pull_request: pr() },
      resolve,
      'delivery-1',
    )
    const b = githubWebhookEvent(
      'pull_request',
      { action: 'opened', repository, pull_request: pr() },
      resolve,
      'delivery-1',
    )
    expect(a?.id).toBe(b?.id as string)
    expect(a?.id).toContain('delivery-1')
  })
})

describe('pull_request_review', () => {
  it('submitted produce el evento con estado y reviewer', () => {
    const e = githubWebhookEvent(
      'pull_request_review',
      {
        action: 'submitted',
        repository,
        pull_request: pr(),
        review: { state: 'CHANGES_REQUESTED', user: { login: 'reviewer' }, body: 'falta un test' },
      },
      resolve,
    )
    expect(e?.type).toBe(PR_REVIEW_SUBMITTED)
    // Normalizado a minúsculas: una regla no debería tener que saber que
    // GitHub lo manda en mayúsculas.
    expect((e?.payload as { state: string }).state).toBe('changes_requested')
    expect((e?.payload as { reviewer: string }).reviewer).toBe('reviewer')
  })

  it('edited y dismissed no son un veredicto nuevo', () => {
    for (const action of ['edited', 'dismissed']) {
      expect(
        githubWebhookEvent(
          'pull_request_review',
          { action, repository, pull_request: pr(), review: { state: 'APPROVED' } },
          resolve,
        ),
      ).toBeNull()
    }
  })
})

describe('ci.finished', () => {
  it('check_suite y workflow_run se normalizan al MISMO tipo', () => {
    // Para una regla son el mismo hecho: el CI de este commit terminó.
    // Publicarlos por separado obligaría a listar los dos en cada regla.
    const suite = githubWebhookEvent(
      'check_suite',
      {
        action: 'completed',
        repository,
        check_suite: { conclusion: 'success', head_branch: 'feat/login', head_sha: 'abc' },
      },
      resolve,
    )
    const run = githubWebhookEvent(
      'workflow_run',
      {
        action: 'completed',
        repository,
        workflow_run: { conclusion: 'failure', head_branch: 'feat/login', head_sha: 'abc' },
      },
      resolve,
    )
    expect(suite?.type).toBe(CI_FINISHED)
    expect(run?.type).toBe(CI_FINISHED)
    expect((suite?.payload as { conclusion: string }).conclusion).toBe('success')
    expect((run?.payload as { conclusion: string }).conclusion).toBe('failure')
  })

  it('conserva de qué mecanismo vino, por si una regla los distingue', () => {
    const e = githubWebhookEvent(
      'check_suite',
      { action: 'completed', repository, check_suite: { conclusion: 'success' } },
      resolve,
    )
    expect((e?.payload as { kind: string }).kind).toBe('check_suite')
  })

  it('ata el resultado a un PR cuando GitHub lo conoce', () => {
    const e = githubWebhookEvent(
      'check_suite',
      {
        action: 'completed',
        repository,
        check_suite: { conclusion: 'success', pull_requests: [{ number: 42 }] },
      },
      resolve,
    )
    expect(e?.scope.prNumber).toBe(42)
  })

  it('sin PR asociado igual produce evento — una regla puede ir por branch', () => {
    const e = githubWebhookEvent(
      'check_suite',
      {
        action: 'completed',
        repository,
        check_suite: { conclusion: 'success', head_branch: 'main' },
      },
      resolve,
    )
    expect(e).not.toBeNull()
    expect(e?.scope.prNumber).toBeUndefined()
    expect((e?.payload as { branch: string }).branch).toBe('main')
  })

  it('una corrida que todavía no terminó no produce evento', () => {
    expect(
      githubWebhookEvent(
        'check_suite',
        { action: 'requested', repository, check_suite: { status: 'queued' } },
        resolve,
      ),
    ).toBeNull()
  })
})
