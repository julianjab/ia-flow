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

// Formas de payload verificadas contra los payload-examples reales de GitHub
// (octokit/webhooks) y un delivery real de producción — no inferidas.
describe('issue_comment', () => {
  // Campos confirmados vía octokit/webhooks/payload-examples/issue_comment/created.payload.json
  const issue = {
    number: 1,
    node_id: 'MDU6SXNzdWU0NDQ1MDAwNDE=',
    title: 'Falla el login',
    state: 'open',
  }
  const comment = {
    id: 492700400,
    node_id: 'MDEyOklzc3VlQ29tbWVudDQ5MjcwMDQwMA==',
    body: '@reviewer esto lo tiene que ver alguien',
    user: { login: 'juli' },
    html_url: 'https://github.com/julianjab/ia-flow/issues/1#issuecomment-492700400',
  }

  it('created produce issue_comment.created con el body y el scope resuelto', () => {
    const e = githubWebhookEvent(
      'issue_comment',
      { action: 'created', repository, issue, comment },
      resolve,
    )
    expect(e?.type).toBe('issue_comment.created')
    expect(e?.scope).toEqual({
      projectId: 'ia-flow',
      repos: ['core'],
      issueId: 'MDU6SXNzdWU0NDQ1MDAwNDE=',
    })
    expect(e?.payload).toEqual({
      action: 'created',
      body: comment.body,
      author: 'juli',
      commentUrl: comment.html_url,
      commentId: comment.node_id,
      issueNumber: 1,
    })
  })

  // GitHub también manda `edited`/`deleted`/`pinned`/`unpinned` — el tipo
  // lleva la acción tal cual, sin filtrar ninguna.
  it('edited produce issue_comment.edited, no issue_comment.created', () => {
    const e = githubWebhookEvent(
      'issue_comment',
      { action: 'edited', repository, issue, comment },
      resolve,
    )
    expect(e?.type).toBe('issue_comment.edited')
  })

  it('sin issue o sin comment no produce evento', () => {
    expect(
      githubWebhookEvent('issue_comment', { action: 'created', repository }, resolve),
    ).toBeNull()
  })

  it('el delivery id incluye el tipo con acción y el id del comentario — no colisionan', () => {
    const e = githubWebhookEvent(
      'issue_comment',
      { action: 'created', repository, issue, comment },
      resolve,
      'delivery-1',
    )
    expect(e?.id).toBe('delivery-1:issue_comment.created:492700400')
  })
})

describe('issues', () => {
  const issue = { number: 3, node_id: 'I_abc', title: 'Bug de carga', state: 'open' }

  it('opened produce issues.opened con el título y el estado', () => {
    const e = githubWebhookEvent('issues', { action: 'opened', repository, issue }, resolve)
    expect(e?.type).toBe('issues.opened')
    expect(e?.scope).toEqual({ projectId: 'ia-flow', repos: ['core'], issueId: 'I_abc' })
    expect(e?.payload).toEqual({
      action: 'opened',
      issueNumber: 3,
      title: 'Bug de carga',
      state: 'open',
      labelName: undefined,
      assignee: undefined,
      labels: [],
    })
  })

  // `labeled`/`unlabeled` traen un `label` a nivel raíz del payload (no
  // anidado en `issue`) — confirmado contra
  // octokit/webhooks/payload-examples/issues/labeled.payload.json.
  it('labeled produce issues.labeled con labelName, desde el label a nivel raíz', () => {
    const e = githubWebhookEvent(
      'issues',
      { action: 'labeled', repository, issue, label: { name: 'bug' } },
      resolve,
    )
    expect(e?.type).toBe('issues.labeled')
    expect((e?.payload as { labelName?: string }).labelName).toBe('bug')
  })

  // `issue.labels` trae el set COMPLETO y actual, no sólo la label que
  // disparó la acción — así `when: [{field:'labels', op:'contains', ...}]`
  // funciona contra el payload del bus igual que contra un Task/SourceItem.
  it('labels sale del set completo de issue.labels, no sólo del label a nivel raíz', () => {
    const e = githubWebhookEvent(
      'issues',
      {
        action: 'labeled',
        repository,
        issue: { ...issue, labels: [{ name: 'epic' }, { name: 'enhancement' }] },
        label: { name: 'epic' },
      },
      resolve,
    )
    expect((e?.payload as { labels?: string[] }).labels).toEqual(['epic', 'enhancement'])
  })

  it('assigned produce issues.assigned con assignee, desde el assignee a nivel raíz', () => {
    const e = githubWebhookEvent(
      'issues',
      { action: 'assigned', repository, issue, assignee: { login: 'juli' } },
      resolve,
    )
    expect(e?.type).toBe('issues.assigned')
    expect((e?.payload as { assignee?: string }).assignee).toBe('juli')
  })

  it('sin issue no produce evento', () => {
    expect(githubWebhookEvent('issues', { action: 'opened', repository }, resolve)).toBeNull()
  })
})

describe('projects_v2_item', () => {
  // Forma real confirmada contra un delivery de producción de
  // `projects_v2_item.edited` con `field_type: 'labels'`: GitHub sólo manda
  // `field_node_id`/`field_type`/`field_name`/`project_number` bajo
  // `changes.field_value` — NUNCA el valor viejo/nuevo, para ningún tipo de
  // campo (ni siquiera `single_select`, según octokit/webhooks/
  // payload-examples/projects_v2_item/edited.payload.json).
  const item = {
    node_id: 'PVTI_lADOAy2Wus4BhjDSzg4y2CU',
    project_node_id: 'PVT_kwDOAy2Wus4BhjDS',
    content_node_id: 'I_kwDOOerJxs8AAAABPArSvA',
    content_type: 'Issue',
  }

  it('edited produce el evento con QUÉ campo cambió, nunca a qué valor', () => {
    const e = githubWebhookEvent(
      'projects_v2_item',
      {
        action: 'edited',
        projects_v2_item: item,
        changes: {
          field_value: {
            field_node_id: 'PVTF_lADOAy2Wus4BhjDSzhgeZfM',
            field_type: 'labels',
            field_name: 'Labels',
            project_number: 119,
          },
        },
      },
      resolve,
      undefined,
      ['ia-flow'],
    )
    expect(e?.type).toBe('projects_v2_item.edited')
    // El scope sale de `projectIds`, NO de `owner/repo` — este payload no trae
    // `repository` en absoluto.
    expect(e?.scope).toEqual({ projectId: 'ia-flow', issueId: 'PVTI_lADOAy2Wus4BhjDSzg4y2CU' })
    expect(e?.payload).toEqual({
      action: 'edited',
      itemId: 'PVTI_lADOAy2Wus4BhjDSzg4y2CU',
      fieldName: 'Labels',
      fieldType: 'labels',
    })
  })

  // Acciones reales, confirmadas contra la documentación de GitHub: archived,
  // converted, created, deleted, edited, reordered, restored.
  it('deleted produce projects_v2_item.deleted', () => {
    const e = githubWebhookEvent(
      'projects_v2_item',
      { action: 'deleted', projects_v2_item: item },
      resolve,
      undefined,
      ['ia-flow'],
    )
    expect(e?.type).toBe('projects_v2_item.deleted')
  })

  it('sin projectIds resuelto queda sin scope, pero se publica igual', () => {
    const e = githubWebhookEvent(
      'projects_v2_item',
      { action: 'created', projects_v2_item: item },
      resolve,
    )
    expect(e?.scope).toEqual({ issueId: 'PVTI_lADOAy2Wus4BhjDSzg4y2CU' })
  })

  it('sin projects_v2_item no produce evento', () => {
    expect(githubWebhookEvent('projects_v2_item', { action: 'edited' }, resolve)).toBeNull()
  })
})

describe('projects_v2', () => {
  // Acciones reales, confirmadas contra la documentación de GitHub: closed,
  // created, deleted, edited, reopened.
  it('edited produce projects_v2.edited, con el proyecto resuelto y sin issueId — habla del proyecto, no de un item', () => {
    const e = githubWebhookEvent(
      'projects_v2',
      { action: 'edited', projects_v2: { node_id: 'PVT_1' } },
      resolve,
      undefined,
      ['ia-flow'],
    )
    expect(e?.type).toBe('projects_v2.edited')
    expect(e?.scope).toEqual({ projectId: 'ia-flow' })
    expect(e?.payload).toEqual({ action: 'edited' })
  })

  it('sin projects_v2 no produce evento', () => {
    expect(githubWebhookEvent('projects_v2', { action: 'edited' }, resolve)).toBeNull()
  })
})
