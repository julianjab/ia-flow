import { describe, expect, it } from 'bun:test'
import {
  AcceptanceCriterionSchema,
  AgentDefinitionSchema,
  AgentProviderChoiceSchema,
  AgentProviderSchema,
  AnthropicApiSettingsSchema,
  ApiContractSchema,
  ExecutionLogSchema,
  FileToModifySchema,
  FunctionalPRDSchema,
  ImpactedRepoSchema,
  ProjectConfigSchema,
  ProjectSchema,
  ProjectSettingsSchema,
  ProviderConfigSchema,
  ProviderLimitSchema,
  RepoContextSchema,
  RepoDependencySchema,
  RepoEntrySchema,
  RepoMappingEntrySchema,
  RepoMappingSchema,
  RepoMappingValueSchema,
  RepoWorkflowSchema,
  SourceRefSchema,
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
  TerminalProviderSettingsSchema,
  TestScenarioSchema,
  UserStorySchema,
  WhenConditionSchema,
  isRuleDisabledInProject,
  toggleDisabledRuleId,
} from '../schemas.js'

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

// ─── AgentProviderSchema / AgentProviderChoiceSchema ────────────────────────

describe('AgentProviderChoiceSchema', () => {
  it('parses a choice with only providerId', () => {
    const result = AgentProviderChoiceSchema.parse({ providerId: 'anthropic-api' })
    expect(result.providerId).toBe('anthropic-api')
    expect(result.when).toBeUndefined()
    expect(result.whenText).toBeUndefined()
  })

  it('parses a choice with when (array) and whenText', () => {
    const result = AgentProviderChoiceSchema.parse({
      providerId: 'tmux-claude',
      when: [{ field: 'type', op: '=', value: 'technical' }],
      whenText: 'para tareas complejas de refactor',
    })
    expect(Array.isArray(result.when)).toBe(true)
    expect(result.whenText).toBe('para tareas complejas de refactor')
  })

  it('parses a choice with legacy record when', () => {
    const result = AgentProviderChoiceSchema.parse({
      providerId: 'anthropic-api',
      when: { type: 'functional' },
    })
    expect(result.when).toEqual({ type: 'functional' })
  })

  it('rejects a choice without providerId', () => {
    expect(() => AgentProviderChoiceSchema.parse({ whenText: 'x' })).toThrow()
  })
})

describe('AgentProviderSchema', () => {
  it('accepts a plain string (forma original)', () => {
    expect(AgentProviderSchema.parse('anthropic-api')).toBe('anthropic-api')
  })

  it('accepts an array of choices (forma nueva, opt-in)', () => {
    const result = AgentProviderSchema.parse([
      { providerId: 'anthropic-api', whenText: 'default' },
      { providerId: 'tmux-claude', when: [{ field: 'type', op: '=', value: 'technical' }] },
    ])
    expect(Array.isArray(result)).toBe(true)
    expect((result as unknown[]).length).toBe(2)
  })

  it('rejects an empty array', () => {
    expect(() => AgentProviderSchema.parse([])).toThrow()
  })

  it('rejects a bare object (not a string, not an array)', () => {
    expect(() => AgentProviderSchema.parse({ providerId: 'x' })).toThrow()
  })
})

describe('AgentDefinitionSchema — provider (string | AgentProviderChoice[])', () => {
  it('sigue aceptando provider como string plano — no rompe agentes existentes', () => {
    const result = AgentDefinitionSchema.parse({ id: 'a', provider: 'anthropic-api', prompt: 'q' })
    expect(result.provider).toBe('anthropic-api')
  })

  it('acepta provider como array de candidatos', () => {
    const result = AgentDefinitionSchema.parse({
      id: 'a',
      provider: [{ providerId: 'anthropic-api' }, { providerId: 'tmux-claude', whenText: 'x' }],
      prompt: 'q',
    })
    expect(Array.isArray(result.provider)).toBe(true)
  })
})

// ─── AgentDefinitionSchema — outcomes ───────────────────────────────────────

describe('AgentDefinitionSchema — outcomes', () => {
  it('accepts onProcess y las salidas como strings opacos', () => {
    const result = AgentDefinitionSchema.parse({
      id: 'a',
      provider: 'p',
      prompt: 'q',
      onProcess: '$set:Labels=+in-progress',
      exits: {
        success: '$set:status=Done,Labels=+ci-checked,-stale',
        error: '$set:Labels==needs-review',
        'back-to-build': '$set:Labels=+agent:build',
      },
    })
    expect(result.onProcess).toBe('$set:Labels=+in-progress')
    expect(result.exits?.success).toBe('$set:status=Done,Labels=+ci-checked,-stale')
    expect(result.exits?.error).toBe('$set:Labels==needs-review')
    // Una salida con nombre propio: la que el agente puede pedir con select_exit.
    expect(result.exits?.['back-to-build']).toBe('$set:Labels=+agent:build')
  })

  it('ya no acepta un canal aparte para labels', () => {
    // Las labels son el campo multi-valor del source dentro del mismo `$set:`,
    // no un segundo canal con su propia primitiva de escritura. Un payload
    // viejo no debe reaparecer como campo válido: el schema lo descarta (no es
    // strict, así que no tira — simplemente no sobrevive al parse).
    const result = AgentDefinitionSchema.parse({
      id: 'a',
      provider: 'p',
      prompt: 'q',
      onFinishLabels: '$labels:+ci-checked',
    })
    expect((result as Record<string, unknown>).onFinishLabels).toBeUndefined()
  })

  it('omite los slots ausentes', () => {
    const result = AgentDefinitionSchema.parse({ id: 'a', provider: 'p', prompt: 'q' })
    expect(result.onProcess).toBeUndefined()
    expect(result.exits).toBeUndefined()
  })

  it('no normaliza ni recorta el string del outcome', () => {
    // Round-trip: whatever the caller shoves in comes out identical.
    const raw = '$set:Labels=+a,+b,-c'
    const result = AgentDefinitionSchema.parse({
      id: 'a',
      provider: 'p',
      prompt: 'q',
      exits: { success: raw },
    })
    expect(result.exits?.success).toBe(raw)
  })
})

// ─── StatusConfigSchema ───────────────────────────────────────────────────────

describe('StatusConfigSchema', () => {
  it('parses minimal status config', () => {
    const result = StatusConfigSchema.parse({ name: 'queued' })
    expect(result.name).toBe('queued')
  })

  it('carries pipeline metadata, not agents', () => {
    const result = StatusConfigSchema.parse({
      name: 'approved',
      projectId: 'p1',
      position: 3,
      allowBlocked: true,
    })
    expect(result.position).toBe(3)
    expect(result.allowBlocked).toBe(true)
    // Un status ya no cablea agentes: la relación vive en AgentDefinition.statusName.
    expect('agents' in result).toBe(false)
  })

  it('ignores a legacy `agents` array instead of failing the parse', () => {
    // Configs viejas (YAML pegado, exports pre-migración) todavía traen la key.
    // Zod la descarta por defecto — importante para que un import legacy no
    // reviente, y para que nadie crea que sigue teniendo efecto.
    const result = StatusConfigSchema.parse({ name: 'approved', agents: [{ agent: 'x' }] })
    expect('agents' in result).toBe(false)
  })
})

// ─── AgentActivationSchema ────────────────────────────────────────────────────

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

  it('accepts tools[] with plain string entries', () => {
    const result = AgentDefinitionSchema.safeParse({
      id: 'a',
      provider: 'anthropic-api',
      prompt: 'p',
      tools: ['fs_read', 'task_write', 'slack_post_message'],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.tools).toEqual(['fs_read', 'task_write', 'slack_post_message'])
    }
  })

  it('accepts a bash_run object entry with allow/deny patterns', () => {
    const result = AgentDefinitionSchema.safeParse({
      id: 'a',
      provider: 'anthropic-api',
      prompt: 'p',
      tools: [
        'fs_read',
        { name: 'bash_run', allow: ['git status', 'npm run *'], deny: ['git push origin main*'] },
      ],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.tools).toEqual([
        'fs_read',
        { name: 'bash_run', allow: ['git status', 'npm run *'], deny: ['git push origin main*'] },
      ])
    }
  })

  it('defaults allow/deny to [] when omitted on a bash_run entry', () => {
    const result = AgentDefinitionSchema.safeParse({
      id: 'a',
      provider: 'anthropic-api',
      prompt: 'p',
      tools: [{ name: 'bash_run' }],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.tools).toEqual([{ name: 'bash_run', allow: [], deny: [] }])
    }
  })

  it('rejects a tool object entry with a name other than bash_run', () => {
    const result = AgentDefinitionSchema.safeParse({
      id: 'a',
      provider: 'anthropic-api',
      prompt: 'p',
      tools: [{ name: 'fs_write', allow: [], deny: [] }],
    })
    expect(result.success).toBe(false)
  })

  it('rejects an empty string tool entry', () => {
    const result = AgentDefinitionSchema.safeParse({
      id: 'a',
      provider: 'anthropic-api',
      prompt: 'p',
      tools: [''],
    })
    expect(result.success).toBe(false)
  })
})

// ─── ProjectConfigSchema ──────────────────────────────────────────────────────

describe('ProjectConfigSchema', () => {
  it('parses empty config', () => {
    expect(() => ProjectConfigSchema.parse({})).not.toThrow()
  })

  it('parses statuses as pipeline stages and agents as the activation carriers', () => {
    // La relación status↔agente vive ahora en el agente (`statusName`), no en
    // el status. Un ProjectConfig completo trae ambas listas en paralelo.
    const result = ProjectConfigSchema.parse({
      statuses: [
        { name: 'queued', position: 0 },
        { name: 'approved', position: 1, allowBlocked: true },
      ],
      agents: [
        { id: 'orchestrator', provider: 'anthropic-api', prompt: 'p', statusName: 'queued' },
        {
          id: 'decomposer',
          provider: 'anthropic-api',
          prompt: 'p',
          statusName: 'approved',
          when: { type: 'functional' },
          exits: { success: '$set:status=refining' },
          position: 1,
        },
        {
          id: 'implementer',
          provider: 'anthropic-api',
          prompt: 'p',
          statusName: 'approved',
          when: [{ field: 'type', op: '=', value: 'technical' }],
          exits: { success: 'done' },
          position: 2,
        },
      ],
    })
    expect(result.statuses).toHaveLength(2)
    expect(result.statuses![1].allowBlocked).toBe(true)
    expect(result.agents![1].exits?.success).toBe('$set:status=refining')
  })
})

// ─── ExecutionLogSchema ──────────────────────────────────────────────────────

describe('ExecutionLogSchema', () => {
  const base = {
    id: 'exec-1',
    projectId: 'proj-1',
    taskId: 'task-1',
    taskTitle: 'Title',
    agentId: 'agent-1',
    providerId: 'provider-1',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: null,
    outcome: null,
    errorMsg: null,
    stopReason: null,
  }

  it('parses the minimal required shape — optional fields absent', () => {
    const result = ExecutionLogSchema.parse(base)
    expect(result.sessionKind).toBeUndefined()
    expect(result.sessionId).toBeUndefined()
    expect(result.source).toBeUndefined()
    expect(result.cancelRequestedAt).toBeUndefined()
  })

  it('accepts null for the optional fields', () => {
    const result = ExecutionLogSchema.parse({
      ...base,
      sessionKind: null,
      sessionId: null,
      source: null,
      cancelRequestedAt: null,
    })
    expect(result.sessionKind).toBeNull()
    expect(result.sessionId).toBeNull()
    expect(result.source).toBeNull()
    expect(result.cancelRequestedAt).toBeNull()
  })

  it('round-trips a fully-populated row including cancelRequestedAt', () => {
    const full = {
      ...base,
      outcome: 'cancelled' as const,
      sessionKind: 'tmux' as const,
      sessionId: 'sess-1',
      source: 'subscriptions-pipeline',
      cancelRequestedAt: '2026-01-01T00:05:00.000Z',
    }
    expect(ExecutionLogSchema.parse(full)).toEqual(full)
  })

  it('rejects a row missing a required field', () => {
    const { id: _id, ...missingId } = base
    expect(() => ExecutionLogSchema.parse(missingId)).toThrow()
  })
})

describe('maxConcurrentRuns vive en los settings de cada provider', () => {
  // No hay tabla de límites: el cap es config adicional del provider, junto a
  // su model / env / mcpServers. El composition root arma el mapa por id que
  // el engine consulta.
  it('anthropic-api lo acepta dentro de sus settings', () => {
    const parsed = AnthropicApiSettingsSchema.parse({
      model: 'claude-opus-5',
      anthropicVersion: '2023-06-01',
      anthropicBeta: [],
      systemPrompt: [],
      maxConcurrentRuns: 2,
    })
    expect(parsed.maxConcurrentRuns).toBe(2)
  })

  it('los providers de terminal también', () => {
    expect(TerminalProviderSettingsSchema.parse({ maxConcurrentRuns: 1 }).maxConcurrentRuns).toBe(1)
  })

  it('es opcional — un provider sin cap queda sin límite', () => {
    expect(TerminalProviderSettingsSchema.parse({}).maxConcurrentRuns).toBeUndefined()
  })

  it('rechaza un valor no numérico: un string desactivaría el cap en silencio', () => {
    expect(() => TerminalProviderSettingsSchema.parse({ maxConcurrentRuns: '5' })).toThrow()
  })
})

describe('ProviderLimitSchema', () => {
  it('acepta un entero no negativo', () => {
    expect(ProviderLimitSchema.parse({ maxConcurrentRuns: 3 })).toEqual({ maxConcurrentRuns: 3 })
  })

  it('acepta el objeto vacío — un provider sin cap declarado', () => {
    expect(ProviderLimitSchema.parse({})).toEqual({})
  })

  it('rechaza un cap no numérico', () => {
    // El modo de falla que esto evita: `running >= "5"` es siempre false, o
    // sea que un string persistido desactiva el cap EN SILENCIO.
    expect(() => ProviderLimitSchema.parse({ maxConcurrentRuns: '5' })).toThrow()
  })

  it('rechaza negativos y fraccionarios', () => {
    expect(() => ProviderLimitSchema.parse({ maxConcurrentRuns: -1 })).toThrow()
    expect(() => ProviderLimitSchema.parse({ maxConcurrentRuns: 1.5 })).toThrow()
  })
})

describe('isRuleDisabledInProject', () => {
  it('una global listada por el proyecto está dada de baja', () => {
    expect(
      isRuleDisabledInProject({ disabledRuleIds: ['r1'] }, { id: 'r1', projectId: null }),
    ).toBe(true)
  })

  it('una regla PROPIA del proyecto no se apaga por acá', () => {
    // Una propia ya tiene su `enabled`, que es donde el operador lo busca.
    // Sin este corte, dar de baja una global se llevaría puesta una propia que
    // casualmente comparta id.
    expect(
      isRuleDisabledInProject({ disabledRuleIds: ['r1'] }, { id: 'r1', projectId: 'p1' }),
    ).toBe(false)
  })

  it('sin lista no hay nada dado de baja', () => {
    expect(isRuleDisabledInProject(undefined, { id: 'r1', projectId: null })).toBe(false)
    expect(isRuleDisabledInProject({ disabledRuleIds: null }, { id: 'r1', projectId: null })).toBe(
      false,
    )
  })

  it('una global que no está en la lista corre', () => {
    expect(isRuleDisabledInProject({ disabledRuleIds: ['otra'] }, { id: 'r1' })).toBe(false)
  })
})

describe('ProjectSettingsSchema.disabledRuleIds', () => {
  it('acepta null sin llevarse puesto el resto del bag', () => {
    // `settings` se mergea por key: vaciar la lista desde la UI persiste un
    // null, y con `.optional()` ese null hacía fallar el objeto ENTERO — se
    // perdían el cap de dispatches y la config de Slack de paso.
    const parsed = ProjectSettingsSchema.safeParse({
      disabledRuleIds: null,
      maxConcurrentDispatches: 3,
    })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.maxConcurrentDispatches).toBe(3)
  })
})

describe('toggleDisabledRuleId', () => {
  it('apagar agrega el id', () => {
    expect(toggleDisabledRuleId([], 'r1', false)).toEqual(['r1'])
  })

  it('apagar dos veces no lo duplica', () => {
    // El endpoint es un PUT: repetirlo tiene que dar el mismo estado.
    expect(toggleDisabledRuleId(['r1'], 'r1', false)).toEqual(['r1'])
  })

  it('prender lo saca', () => {
    expect(toggleDisabledRuleId(['r1', 'r2'], 'r1', true)).toEqual(['r2'])
  })

  it('prender algo que no estaba no cambia nada', () => {
    expect(toggleDisabledRuleId(['r2'], 'r1', true)).toEqual(['r2'])
  })

  it('no muta la lista que recibe', () => {
    const current = ['r1']
    toggleDisabledRuleId(current, 'r2', false)
    expect(current).toEqual(['r1'])
  })
})
