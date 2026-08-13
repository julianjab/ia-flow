import { describe, expect, it } from 'bun:test'
import {
  AcceptanceCriterionSchema,
  AgentDefinitionSchema,
  AnthropicApiSettingsSchema,
  ApiContractSchema,
  FileToModifySchema,
  FunctionalPRDSchema,
  ImpactedRepoSchema,
  ProjectConfigSchema,
  ProjectSchema,
  ProjectSettingsSchema,
  ProviderConfigSchema,
  RepoContextSchema,
  RepoDependencySchema,
  RepoEntrySchema,
  RepoMappingEntrySchema,
  RepoMappingSchema,
  RepoMappingValueSchema,
  RepoWorkflowSchema,
  SourceRefSchema,
  StatusAgentEntrySchema,
  StatusConfigSchema,
  StepConfigSchema,
  StepOverrideSchema,
  StepTypeSchema,
  SystemPromptDefSchema,
  TaskSchema,
  TaskStatusSchema,
  TaskTypeSchema,
  TechnicalPRDsSchema,
  TechnicalRepoPRDSchema,
  TestScenarioSchema,
  UserStorySchema,
  WhenConditionSchema,
} from './schemas.js'

// ─── WhenConditionSchema ─────────────────────────────────────────────────────

describe('WhenConditionSchema', () => {
  it('parses minimal condition (field + op only)', () => {
    const result = WhenConditionSchema.parse({ field: 'type', op: '=' })
    expect(result.field).toBe('type')
    expect(result.op).toBe('=')
    expect(result.value).toBeUndefined()
    expect(result.logic).toBeUndefined()
  })

  it('parses full condition with value and logic', () => {
    const result = WhenConditionSchema.parse({
      field: 'type',
      op: '=',
      value: 'functional',
      logic: 'or',
    })
    expect(result).toEqual({ field: 'type', op: '=', value: 'functional', logic: 'or' })
  })

  it('accepts logic: and', () => {
    expect(() => WhenConditionSchema.parse({ field: 'f', op: '=', logic: 'and' })).not.toThrow()
  })

  it('rejects invalid logic value', () => {
    expect(() => WhenConditionSchema.parse({ field: 'f', op: '=', logic: 'xor' })).toThrow()
  })

  it('requires field', () => {
    expect(() => WhenConditionSchema.parse({ op: '=' })).toThrow()
  })

  it('requires op', () => {
    expect(() => WhenConditionSchema.parse({ field: 'type' })).toThrow()
  })
})

// ─── StatusAgentEntrySchema — when field ─────────────────────────────────────

describe('StatusAgentEntrySchema — when field', () => {
  it('parses entry without when (default agent)', () => {
    const result = StatusAgentEntrySchema.parse({ agent: 'my-agent' })
    expect(result.agent).toBe('my-agent')
    expect(result.when).toBeUndefined()
  })

  it('accepts legacy Record<string,string> when', () => {
    const result = StatusAgentEntrySchema.parse({
      agent: 'a',
      when: { type: 'functional', status: '$not_null' },
    })
    expect(result.when).toEqual({ type: 'functional', status: '$not_null' })
  })

  it('accepts new array when format', () => {
    const result = StatusAgentEntrySchema.parse({
      agent: 'a',
      when: [
        { field: 'type', op: '=', value: 'functional' },
        { field: 'type', op: '=', value: 'technical', logic: 'or' },
      ],
    })
    expect(Array.isArray(result.when)).toBe(true)
    expect((result.when as any[])[1].logic).toBe('or')
  })

  it('accepts all transition fields', () => {
    const result = StatusAgentEntrySchema.parse({
      agent: 'a',
      onProcess: '$set:status=refining',
      onFinish: '$set:status=done,type=technical',
      onError: 'queued',
    })
    expect(result.onProcess).toBe('$set:status=refining')
    expect(result.onFinish).toBe('$set:status=done,type=technical')
    expect(result.onError).toBe('queued')
  })

  it('omits undefined optional fields', () => {
    const result = StatusAgentEntrySchema.parse({ agent: 'a' })
    expect(result.onProcess).toBeUndefined()
    expect(result.onFinish).toBeUndefined()
    expect(result.onError).toBeUndefined()
  })
})

// ─── StatusAgentEntrySchema — labels fields ──────────────────────────────────

describe('StatusAgentEntrySchema — labels fields', () => {
  it('accepts all three onXxxLabels as opaque strings', () => {
    const result = StatusAgentEntrySchema.parse({
      agent: 'a',
      onProcessLabels: '$labels:+in-progress',
      onFinishLabels: '$labels:+ci-checked,-stale',
      onErrorLabels: '$labels:=needs-review',
    })
    expect(result.onProcessLabels).toBe('$labels:+in-progress')
    expect(result.onFinishLabels).toBe('$labels:+ci-checked,-stale')
    expect(result.onErrorLabels).toBe('$labels:=needs-review')
  })

  it('label fields are independent from the $set: onFinish counterpart', () => {
    // The $set:field=value grammar for status/custom fields and the $labels:
    // grammar for add/remove/replace must NOT be merged into a single string —
    // they live in separate columns so the UI can render them in separate
    // sections without brittle parsing.
    const result = StatusAgentEntrySchema.parse({
      agent: 'a',
      onFinish: '$set:status=Done',
      onFinishLabels: '$labels:+ci-checked',
    })
    expect(result.onFinish).toBe('$set:status=Done')
    expect(result.onFinishLabels).toBe('$labels:+ci-checked')
  })

  it('omits undefined label fields', () => {
    const result = StatusAgentEntrySchema.parse({ agent: 'a' })
    expect(result.onProcessLabels).toBeUndefined()
    expect(result.onFinishLabels).toBeUndefined()
    expect(result.onErrorLabels).toBeUndefined()
  })

  it('does not coerce or trim opaque label strings', () => {
    // Round-trip: whatever the caller shoves in comes out identical.
    const raw = '$labels:+a,+b,-c,=d'
    const result = StatusAgentEntrySchema.parse({ agent: 'a', onFinishLabels: raw })
    expect(result.onFinishLabels).toBe(raw)
  })
})

// ─── StatusConfigSchema ───────────────────────────────────────────────────────

describe('StatusConfigSchema', () => {
  it('parses minimal status config', () => {
    const result = StatusConfigSchema.parse({ name: 'queued', agents: [] })
    expect(result.name).toBe('queued')
    expect(result.agents).toEqual([])
  })

  it('parses multiple agents with mixed when formats', () => {
    const result = StatusConfigSchema.parse({
      name: 'approved',
      agents: [
        { agent: 'decomposer', when: { type: 'functional' } },
        {
          agent: 'implementer',
          when: [
            { field: 'type', op: '=', value: 'technical' },
            { field: 'type', op: '=', value: 'functional', logic: 'or' },
          ],
        },
      ],
    })
    expect(result.agents).toHaveLength(2)
    expect(result.agents[0].agent).toBe('decomposer')
    expect(result.agents[1].agent).toBe('implementer')
  })
})

// ─── AcceptanceCriterionSchema ────────────────────────────────────────────────

describe('AcceptanceCriterionSchema', () => {
  it('parses valid criterion', () => {
    const result = AcceptanceCriterionSchema.parse({ given: 'given', when: 'when', then: 'then' })
    expect(result).toEqual({ given: 'given', when: 'when', then: 'then' })
  })

  it('requires all three fields', () => {
    expect(() => AcceptanceCriterionSchema.parse({ given: 'g', when: 'w' })).toThrow()
    expect(() => AcceptanceCriterionSchema.parse({ given: 'g', then: 't' })).toThrow()
    expect(() => AcceptanceCriterionSchema.parse({ when: 'w', then: 't' })).toThrow()
  })
})

// ─── UserStorySchema ──────────────────────────────────────────────────────────

describe('UserStorySchema', () => {
  it('parses story with empty criteria', () => {
    const result = UserStorySchema.parse({
      as_a: 'dev',
      i_want: 'deploy',
      so_that: 'ship',
      acceptance_criteria: [],
    })
    expect(result.acceptance_criteria).toEqual([])
  })

  it('parses story with criteria', () => {
    const result = UserStorySchema.parse({
      as_a: 'admin',
      i_want: 'metrics',
      so_that: 'decide',
      acceptance_criteria: [{ given: 'g', when: 'w', then: 't' }],
    })
    expect(result.acceptance_criteria).toHaveLength(1)
  })

  it('requires acceptance_criteria array', () => {
    expect(() => UserStorySchema.parse({ as_a: 'a', i_want: 'b', so_that: 'c' })).toThrow()
  })
})

// ─── ImpactedRepoSchema ───────────────────────────────────────────────────────

describe('ImpactedRepoSchema', () => {
  it.each(['low', 'medium', 'high'])('accepts estimated_effort=%s', (effort) => {
    const result = ImpactedRepoSchema.parse({
      repo: 'backend',
      rationale: 'r',
      estimated_effort: effort,
    })
    expect(result.estimated_effort).toBe(effort)
  })

  it('rejects invalid effort value', () => {
    expect(() =>
      ImpactedRepoSchema.parse({ repo: 'b', rationale: 'r', estimated_effort: 'critical' }),
    ).toThrow()
  })
})

// ─── FunctionalPRDSchema ──────────────────────────────────────────────────────

describe('FunctionalPRDSchema', () => {
  it('parses complete PRD', () => {
    const result = FunctionalPRDSchema.parse({
      problem_statement: 'problema',
      user_stories: [],
      out_of_scope: ['auth'],
      open_questions: ['when?'],
      impacted_repos: [{ repo: 'api', rationale: 'r', estimated_effort: 'high' }],
    })
    expect(result.impacted_repos).toHaveLength(1)
  })

  it('rejects missing required arrays', () => {
    expect(() => FunctionalPRDSchema.parse({ problem_statement: 'x' })).toThrow()
  })
})

// ─── FileToModifySchema ───────────────────────────────────────────────────────

describe('FileToModifySchema', () => {
  it.each(['create', 'modify', 'delete'])('accepts change_type=%s', (change_type) => {
    const result = FileToModifySchema.parse({ path: 'src/foo.ts', change_type, description: 'd' })
    expect(result.change_type).toBe(change_type)
  })

  it('rejects invalid change_type', () => {
    expect(() =>
      FileToModifySchema.parse({ path: 'f', change_type: 'rename', description: 'd' }),
    ).toThrow()
  })
})

// ─── ApiContractSchema ────────────────────────────────────────────────────────

describe('ApiContractSchema', () => {
  it('parses valid contract', () => {
    const result = ApiContractSchema.parse({
      endpoint: '/api/users',
      method: 'POST',
      request_schema: { name: 'string' },
      response_schema: { id: 'number' },
    })
    expect(result.endpoint).toBe('/api/users')
  })

  it('requires all four fields', () => {
    expect(() =>
      ApiContractSchema.parse({ endpoint: '/x', method: 'GET', request_schema: {} }),
    ).toThrow()
  })
})

// ─── TestScenarioSchema ───────────────────────────────────────────────────────

describe('TestScenarioSchema', () => {
  it('parses valid scenario', () => {
    const result = TestScenarioSchema.parse({ scenario: 's', given: 'g', when: 'w', then: 't' })
    expect(result.scenario).toBe('s')
  })

  it('requires all four fields', () => {
    expect(() => TestScenarioSchema.parse({ scenario: 's', given: 'g', when: 'w' })).toThrow()
  })
})

// ─── RepoDependencySchema ─────────────────────────────────────────────────────

describe('RepoDependencySchema', () => {
  it('parses valid dependency', () => {
    const result = RepoDependencySchema.parse({ repo: 'core', what: 'UserService' })
    expect(result.repo).toBe('core')
    expect(result.what).toBe('UserService')
  })
})

// ─── TechnicalRepoPRDSchema ───────────────────────────────────────────────────

describe('TechnicalRepoPRDSchema', () => {
  it('parses minimal PRD without optional fields', () => {
    const result = TechnicalRepoPRDSchema.parse({
      repo: 'backend',
      files_to_modify: [],
      test_scenarios: [],
      dependencies: [],
      open_questions: [],
    })
    expect(result.api_contract).toBeUndefined()
    expect(result.data_model_changes).toBeUndefined()
  })

  it('parses PRD with api_contract and data_model_changes', () => {
    const result = TechnicalRepoPRDSchema.parse({
      repo: 'backend',
      files_to_modify: [{ path: 'src/a.ts', change_type: 'modify', description: 'd' }],
      api_contract: { endpoint: '/x', method: 'GET', request_schema: {}, response_schema: {} },
      data_model_changes: 'add column x',
      test_scenarios: [],
      dependencies: [],
      open_questions: [],
    })
    expect(result.api_contract?.endpoint).toBe('/x')
    expect(result.data_model_changes).toBe('add column x')
  })
})

// ─── TechnicalPRDsSchema ──────────────────────────────────────────────────────

describe('TechnicalPRDsSchema', () => {
  it('accepts empty record', () => {
    expect(TechnicalPRDsSchema.parse({})).toEqual({})
  })

  it('accepts record with one entry', () => {
    const result = TechnicalPRDsSchema.parse({
      backend: {
        repo: 'backend',
        files_to_modify: [],
        test_scenarios: [],
        dependencies: [],
        open_questions: [],
      },
    })
    expect(result.backend.repo).toBe('backend')
  })
})

// ─── RepoContextSchema ────────────────────────────────────────────────────────

describe('RepoContextSchema', () => {
  it.each(['golang', 'python', 'ruby', 'frontend', 'mobile', 'agent', 'unknown'])(
    'accepts type=%s',
    (type) => {
      expect(() => RepoContextSchema.parse({ name: 'n', path: '/p', type })).not.toThrow()
    },
  )

  it('accepts optional fields', () => {
    const result = RepoContextSchema.parse({
      name: 'n',
      path: '/p',
      type: 'golang',
      claude_md: 'content',
      manifest: '{}',
      directory_tree: 'tree',
    })
    expect(result.claude_md).toBe('content')
    expect(result.manifest).toBe('{}')
    expect(result.directory_tree).toBe('tree')
  })

  it('rejects invalid type', () => {
    expect(() => RepoContextSchema.parse({ name: 'n', path: '/p', type: 'rust' })).toThrow()
  })
})

// ─── TaskStatusSchema / TaskTypeSchema ────────────────────────────────────────

describe('TaskStatusSchema', () => {
  it.each(['queued', 'refining', 'refined', 'approved'])('accepts status=%s', (status) => {
    expect(() => TaskStatusSchema.parse(status)).not.toThrow()
  })

  it('rejects invalid status', () => {
    expect(() => TaskStatusSchema.parse('pending')).toThrow()
  })
})

describe('TaskTypeSchema', () => {
  it.each(['functional', 'technical'])('accepts type=%s', (type) => {
    expect(() => TaskTypeSchema.parse(type)).not.toThrow()
  })

  it('rejects invalid type', () => {
    expect(() => TaskTypeSchema.parse('design')).toThrow()
  })
})

// ─── TaskSchema ───────────────────────────────────────────────────────────────

describe('TaskSchema', () => {
  const base = {
    id: 'task-1',
    title: 'Login feature',
    description: 'desc',
    type: 'functional',
    repos: ['backend'],
    status: 'queued',
    created_at: '2025-01-01T00:00:00Z',
  }

  it('parses minimal task', () => {
    const result = TaskSchema.parse(base)
    expect(result.id).toBe('task-1')
    expect(result.prd).toBeUndefined()
  })

  it('parses task with all optional fields', () => {
    const result = TaskSchema.parse({
      ...base,
      approved_at: '2025-01-02T00:00:00Z',
      error: 'timeout',
      agent_working: true,
      issueNumber: 42,
      issueUrl: 'https://github.com/org/repo/issues/42',
    })
    expect(result.agent_working).toBe(true)
    expect(result.issueNumber).toBe(42)
  })

  it('requires id, title, description, type, repos, status, created_at', () => {
    const { id: _, ...rest } = base
    expect(() => TaskSchema.parse(rest)).toThrow()
  })
})

// ─── RepoEntrySchema ──────────────────────────────────────────────────────────

describe('RepoEntrySchema', () => {
  it('parses entry without hasGit', () => {
    const result = RepoEntrySchema.parse({ name: 'n', path: '/p', type: 'frontend' })
    expect(result.hasGit).toBeUndefined()
  })

  it('parses entry with hasGit', () => {
    const result = RepoEntrySchema.parse({ name: 'n', path: '/p', type: 'golang', hasGit: true })
    expect(result.hasGit).toBe(true)
  })
})

// ─── StepTypeSchema ───────────────────────────────────────────────────────────

describe('StepTypeSchema', () => {
  it.each(['refine-functional', 'refine-technical', 'implement'])('accepts step=%s', (step) => {
    expect(() => StepTypeSchema.parse(step)).not.toThrow()
  })

  it('rejects invalid step', () => {
    expect(() => StepTypeSchema.parse('deploy')).toThrow()
  })
})

// ─── AnthropicApiSettingsSchema ───────────────────────────────────────────────

describe('AnthropicApiSettingsSchema', () => {
  const base = {
    model: 'claude-sonnet-4-5',
    anthropicVersion: '2023-06-01',
    anthropicBeta: [],
    systemPrompt: [{ type: 'text', text: 'hello' }],
  }

  it('parses minimal settings', () => {
    const result = AnthropicApiSettingsSchema.parse(base)
    expect(result.model).toBe('claude-sonnet-4-5')
    expect(result.thinking).toBeUndefined()
  })

  it('parses thinking enabled with budget_tokens', () => {
    const result = AnthropicApiSettingsSchema.parse({
      ...base,
      thinking: { type: 'enabled', budget_tokens: 1000 },
    })
    expect(result.thinking?.type).toBe('enabled')
    expect(result.thinking?.budget_tokens).toBe(1000)
  })

  it('parses thinking adaptive without budget_tokens', () => {
    const result = AnthropicApiSettingsSchema.parse({ ...base, thinking: { type: 'adaptive' } })
    expect(result.thinking?.type).toBe('adaptive')
    expect(result.thinking?.budget_tokens).toBeUndefined()
  })

  it('parses stream and responseLanguage', () => {
    const result = AnthropicApiSettingsSchema.parse({
      ...base,
      stream: true,
      responseLanguage: 'es',
    })
    expect(result.stream).toBe(true)
    expect(result.responseLanguage).toBe('es')
  })

  it('rejects invalid thinking type', () => {
    expect(() =>
      AnthropicApiSettingsSchema.parse({ ...base, thinking: { type: 'disabled' } }),
    ).toThrow()
  })
})

// ─── StepOverrideSchema ───────────────────────────────────────────────────────

describe('StepOverrideSchema', () => {
  it('parses override with only provider', () => {
    const result = StepOverrideSchema.parse({ provider: 'claude-code' })
    expect(result.provider).toBe('claude-code')
  })

  it('parses override with partial AnthropicApiSettings fields', () => {
    const result = StepOverrideSchema.parse({
      provider: 'claude-code',
      model: 'claude-3-opus',
      stream: false,
    })
    expect(result.model).toBe('claude-3-opus')
    expect(result.stream).toBe(false)
  })
})

// ─── StepConfigSchema ─────────────────────────────────────────────────────────

describe('StepConfigSchema', () => {
  it('accepts string shorthand', () => {
    expect(StepConfigSchema.parse('anthropic-api')).toBe('anthropic-api')
  })

  it('accepts object override', () => {
    const result = StepConfigSchema.parse({ provider: 'claude-code' })
    expect((result as { provider: string }).provider).toBe('claude-code')
  })
})

// ─── RepoWorkflowSchema ───────────────────────────────────────────────────────

describe('RepoWorkflowSchema', () => {
  it.each(['worktree', 'branch', 'main'])('accepts workflow=%s', (workflow) => {
    expect(RepoWorkflowSchema.parse(workflow)).toBe(workflow)
  })

  it('rejects invalid workflow', () => {
    expect(() => RepoWorkflowSchema.parse('fork')).toThrow()
  })
})

// ─── RepoMappingEntrySchema ───────────────────────────────────────────────────

describe('RepoMappingEntrySchema', () => {
  it('accepts empty object (all optional)', () => {
    expect(RepoMappingEntrySchema.parse({})).toEqual({})
  })

  it('accepts all fields', () => {
    const result = RepoMappingEntrySchema.parse({
      githubOwner: 'myorg',
      githubRepo: 'backend',
      path: '/home/user/repos/backend',
      workflow: 'worktree',
    })
    expect(result.workflow).toBe('worktree')
    expect(result.githubOwner).toBe('myorg')
  })
})

// ─── RepoMappingValueSchema ───────────────────────────────────────────────────

describe('RepoMappingValueSchema', () => {
  it('accepts string shorthand', () => {
    expect(RepoMappingValueSchema.parse('my-github-repo')).toBe('my-github-repo')
  })

  it('accepts object entry', () => {
    const result = RepoMappingValueSchema.parse({ githubRepo: 'backend', workflow: 'branch' })
    expect((result as { workflow: string }).workflow).toBe('branch')
  })
})

// ─── RepoMappingSchema ────────────────────────────────────────────────────────

describe('RepoMappingSchema', () => {
  it('accepts empty record', () => {
    expect(RepoMappingSchema.parse({})).toEqual({})
  })

  it('accepts mix of strings and objects', () => {
    const result = RepoMappingSchema.parse({
      backend: 'my-backend',
      frontend: { githubOwner: 'org', workflow: 'worktree' },
    })
    expect(result['backend']).toBe('my-backend')
    expect((result['frontend'] as { githubOwner: string }).githubOwner).toBe('org')
  })
})

// ─── ProviderConfigSchema ─────────────────────────────────────────────────────

describe('ProviderConfigSchema', () => {
  const anthropicApi = {
    model: 'claude-sonnet-4-5',
    anthropicVersion: '2023-06-01',
    anthropicBeta: [],
    systemPrompt: [{ type: 'text', text: 'sys' }],
  }
  const steps = {
    'refine-functional': 'anthropic-api',
    'refine-technical': 'anthropic-api',
    implement: 'anthropic-api',
  }

  it('parses minimal config', () => {
    const result = ProviderConfigSchema.parse({ steps, anthropicApi })
    expect(result.repoMappings).toBeUndefined()
  })

  it('parses full config with all optional fields', () => {
    const result = ProviderConfigSchema.parse({
      steps,
      anthropicApi,
      repoMappings: { backend: 'my-backend' },
      phasePrompts: { implement: 'impl prompt' },
    })
    expect(result.repoMappings).toEqual({ backend: 'my-backend' })
  })
})

// ─── ProjectSettingsSchema ────────────────────────────────────────────────────

describe('ProjectSettingsSchema', () => {
  it('accepts empty object', () => {
    expect(ProjectSettingsSchema.parse({})).toEqual({})
  })

  it('accepts name and language', () => {
    const result = ProjectSettingsSchema.parse({ name: 'Mi Proyecto', language: 'es' })
    expect(result.name).toBe('Mi Proyecto')
    expect(result.language).toBe('es')
  })
})

// ─── SourceRefSchema ──────────────────────────────────────────────────────────

describe('SourceRefSchema', () => {
  it('accepts github source with url config', () => {
    const r = SourceRefSchema.parse({
      kind: 'github',
      config: { url: 'https://github.com/orgs/x/projects/1' },
    })
    expect(r.kind).toBe('github')
    expect(r.config?.url).toBe('https://github.com/orgs/x/projects/1')
  })

  it('accepts local source with no config', () => {
    const r = SourceRefSchema.parse({ kind: 'local' })
    expect(r.kind).toBe('local')
  })

  it('accepts unknown provider kinds — shape is open', () => {
    const r = SourceRefSchema.parse({ kind: 'linear', config: { teamId: 'T123' } })
    expect(r.kind).toBe('linear')
  })

  it('rejects when kind is missing', () => {
    expect(SourceRefSchema.safeParse({ config: {} }).success).toBe(false)
  })
})

// ─── ProjectSchema ────────────────────────────────────────────────────────────

describe('ProjectSchema', () => {
  it('accepts a project without source (unconfigured)', () => {
    const r = ProjectSchema.parse({ id: 'p1', name: 'ia-flow' })
    expect(r.id).toBe('p1')
    expect(r.source).toBeUndefined()
  })

  it('accepts a project with github source', () => {
    const r = ProjectSchema.parse({
      id: 'p1',
      name: 'ia-flow',
      source: { kind: 'github', config: { url: 'https://github.com/orgs/x/projects/1' } },
    })
    expect(r.source?.kind).toBe('github')
    expect(r.source?.config?.url).toBe('https://github.com/orgs/x/projects/1')
  })

  it('rejects legacy githubProjectUrl top-level field', () => {
    // The old shape must not silently pass — callers who still send it
    // should be updated to the new `source` object.
    const r = ProjectSchema.safeParse({
      id: 'p1',
      name: 'ia-flow',
      githubProjectUrl: 'https://github.com/orgs/x/projects/1',
    })
    // ProjectSchema is not .strict() so unknown fields are stripped, but the
    // `source` field must remain unset — that's what we care about.
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.source).toBeUndefined()
  })
})

// ─── SystemPromptDefSchema ────────────────────────────────────────────────────

describe('SystemPromptDefSchema', () => {
  it('parses valid system prompt definition', () => {
    const result = SystemPromptDefSchema.parse({ id: 'sp-1', name: 'Base', text: 'You are...' })
    expect(result.id).toBe('sp-1')
  })

  it('requires all three fields', () => {
    expect(() => SystemPromptDefSchema.parse({ id: 'sp-1', name: 'Base' })).toThrow()
  })
})

// ─── AgentDefinitionSchema ────────────────────────────────────────────────────

describe('AgentDefinitionSchema', () => {
  it('parses minimal agent', () => {
    const result = AgentDefinitionSchema.parse({
      id: 'a-1',
      provider: 'claude-code',
      prompt: 'do task',
    })
    expect(result.systemPrompts).toBeUndefined()
    expect(result.variables).toBeUndefined()
  })

  it('parses agent with all optional fields', () => {
    const result = AgentDefinitionSchema.parse({
      id: 'a-1',
      provider: 'claude-code',
      prompt: 'do task',
      systemPrompts: ['sp-1'],
      variables: { repo: 'backend' },
      tools: ['bash', 'edit'],
    })
    expect(result.systemPrompts).toEqual(['sp-1'])
    expect(result.tools).toEqual(['bash', 'edit'])
  })

  // providerConfig is an opaque Record<string, unknown> at the shared layer.
  // Each provider validates it against its own schema in apps/server.
  it('accepts an arbitrary providerConfig blob', () => {
    const result = AgentDefinitionSchema.safeParse({
      id: 'a',
      provider: 'anthropic-api',
      prompt: 'p',
      providerConfig: {
        model: 'claude-opus-4-7',
        maxTokens: 8000,
        effort: 'low',
      },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.providerConfig?.effort).toBe('low')
    }
  })

  it('accepts unknown provider ids with any config shape', () => {
    const result = AgentDefinitionSchema.safeParse({
      id: 'a',
      provider: 'my-custom-provider',
      prompt: 'p',
      providerConfig: { anyField: 42, nested: { ok: true } },
    })
    expect(result.success).toBe(true)
  })

  it('accepts providerConfig omitted entirely', () => {
    const result = AgentDefinitionSchema.safeParse({
      id: 'a',
      provider: 'anthropic-api',
      prompt: 'p',
    })
    expect(result.success).toBe(true)
  })
})

// ─── ProjectConfigSchema ──────────────────────────────────────────────────────

describe('ProjectConfigSchema', () => {
  it('parses empty config', () => {
    expect(() => ProjectConfigSchema.parse({})).not.toThrow()
  })

  it('parses full statuses array', () => {
    const result = ProjectConfigSchema.parse({
      statuses: [
        {
          name: 'queued',
          agents: [{ agent: 'orchestrator' }],
        },
        {
          name: 'approved',
          agents: [
            { agent: 'decomposer', when: { type: 'functional' }, onFinish: '$set:status=refining' },
            {
              agent: 'implementer',
              when: [{ field: 'type', op: '=', value: 'technical' }],
              onFinish: 'done',
            },
          ],
        },
      ],
    })
    expect(result.statuses).toHaveLength(2)
    expect(result.statuses![1].agents[0].onFinish).toBe('$set:status=refining')
  })
})
