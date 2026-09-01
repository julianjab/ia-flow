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
  it('acepta los ocho que producen eventos, y nada más', () => {
    for (const e of [
      'pull_request',
      'pull_request_review',
      'check_suite',
      'workflow_run',
      'issue_comment',
      'issues',
      'projects_v2_item',
      'projects_v2',
    ]) {
      expect(isBusEvent(e)).toBe(true)
    }
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

describe('issue_comment', () => {
  const issue = { number: 7, node_id: 'I_kgD1', title: 'Falla el login', state: 'open' }
  const comment = {
    id: 999,
    body: '@reviewer esto lo tiene que ver alguien',
    user: { login: 'juli' },
    html_url: 'https://github.com/julianjab/ia-flow/issues/7#comment-999',
  }

  it('created produce issue_comment con el body y el scope resuelto', () => {
    const e = githubWebhookEvent(
      'issue_comment',
      { action: 'created', repository, issue, comment },
      resolve,
    )
    expect(e?.type).toBe('issue_comment')
    expect(e?.scope).toEqual({ projectId: 'ia-flow', repos: ['core'], issueId: 'I_kgD1' })
    expect(e?.payload).toEqual({
      action: 'created',
      body: comment.body,
      author: 'juli',
      commentUrl: comment.html_url,
      issueNumber: 7,
    })
  })

  it('sin issue o sin comment no produce evento', () => {
    expect(
      githubWebhookEvent('issue_comment', { action: 'created', repository }, resolve),
    ).toBeNull()
  })

  it('el delivery id incluye el id del comentario — dos comentarios del mismo delivery no colisionan', () => {
    const e = githubWebhookEvent(
      'issue_comment',
      { action: 'created', repository, issue, comment },
      resolve,
      'delivery-1',
    )
    expect(e?.id).toBe('delivery-1:issue_comment:999')
  })
})

describe('issues', () => {
  it('labeled produce issues con el título y el estado', () => {
    const e = githubWebhookEvent(
      'issues',
      {
        action: 'labeled',
        repository,
        issue: { number: 3, node_id: 'I_abc', title: 'Bug de carga', state: 'open' },
      },
      resolve,
    )
    expect(e?.type).toBe('issues')
    expect(e?.scope).toEqual({ projectId: 'ia-flow', repos: ['core'], issueId: 'I_abc' })
    expect(e?.payload).toEqual({
      action: 'labeled',
      issueNumber: 3,
      title: 'Bug de carga',
      state: 'open',
    })
  })

  it('sin issue no produce evento', () => {
    expect(githubWebhookEvent('issues', { action: 'opened', repository }, resolve)).toBeNull()
  })
})

describe('projects_v2_item', () => {
  const item = { node_id: 'PVTI_1', project_node_id: 'PVT_1' }

  it('edited con field_value produce el evento con el proyecto resuelto por projectIds', () => {
    const e = githubWebhookEvent(
      'projects_v2_item',
      {
        action: 'edited',
        projects_v2_item: item,
        changes: { field_value: { field_name: 'Status', field_value: 'In Progress' } },
      },
      resolve,
      undefined,
      ['ia-flow'],
    )
    expect(e?.type).toBe('projects_v2_item')
    // El scope sale de `projectIds`, NO de `owner/repo` — este payload no trae
    // `repository` en absoluto.
    expect(e?.scope).toEqual({ projectId: 'ia-flow', issueId: 'PVTI_1' })
    expect(e?.payload).toEqual({
      action: 'edited',
      itemId: 'PVTI_1',
      fieldName: 'Status',
      fieldValue: 'In Progress',
    })
  })

  it('sin projectIds resuelto queda sin scope, pero se publica igual', () => {
    const e = githubWebhookEvent(
      'projects_v2_item',
      { action: 'created', projects_v2_item: item },
      resolve,
    )
    expect(e?.scope).toEqual({ issueId: 'PVTI_1' })
  })

  it('sin projects_v2_item no produce evento', () => {
    expect(githubWebhookEvent('projects_v2_item', { action: 'edited' }, resolve)).toBeNull()
  })
})

describe('projects_v2', () => {
  it('produce el evento con el proyecto resuelto, sin issueId — habla del proyecto, no de un item', () => {
    const e = githubWebhookEvent(
      'projects_v2',
      { action: 'edited', projects_v2: { node_id: 'PVT_1' } },
      resolve,
      undefined,
      ['ia-flow'],
    )
    expect(e?.type).toBe('projects_v2')
    expect(e?.scope).toEqual({ projectId: 'ia-flow' })
    expect(e?.payload).toEqual({ action: 'edited' })
  })

  it('sin projects_v2 no produce evento', () => {
    expect(githubWebhookEvent('projects_v2', { action: 'edited' }, resolve)).toBeNull()
  })
})
