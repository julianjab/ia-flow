import { z } from 'zod'

// ─── Acceptance Criteria ──────────────────────────────────────────────────────

export const AcceptanceCriterionSchema = z.object({
  given: z.string(),
  when: z.string(),
  then: z.string(),
})

// ─── User Stories ─────────────────────────────────────────────────────────────

export const UserStorySchema = z.object({
  as_a: z.string(),
  i_want: z.string(),
  so_that: z.string(),
  acceptance_criteria: z.array(AcceptanceCriterionSchema),
})

// ─── Impacted Repo ────────────────────────────────────────────────────────────

export const ImpactedRepoSchema = z.object({
  repo: z.string(),
  rationale: z.string(),
  estimated_effort: z.enum(['low', 'medium', 'high']),
})

// ─── Functional PRD ───────────────────────────────────────────────────────────

export const FunctionalPRDSchema = z.object({
  problem_statement: z.string(),
  user_stories: z.array(UserStorySchema),
  out_of_scope: z.array(z.string()),
  open_questions: z.array(z.string()),
  impacted_repos: z.array(ImpactedRepoSchema),
})

// ─── Technical PRD (per repo) ─────────────────────────────────────────────────

export const FileToModifySchema = z.object({
  path: z.string(),
  change_type: z.enum(['create', 'modify', 'delete']),
  description: z.string(),
})

export const ApiContractSchema = z.object({
  endpoint: z.string(),
  method: z.string(),
  request_schema: z.record(z.unknown()),
  response_schema: z.record(z.unknown()),
})

export const TestScenarioSchema = z.object({
  scenario: z.string(),
  given: z.string(),
  when: z.string(),
  then: z.string(),
})

export const RepoDependencySchema = z.object({
  repo: z.string(),
  what: z.string(),
})

export const TechnicalRepoPRDSchema = z.object({
  repo: z.string(),
  files_to_modify: z.array(FileToModifySchema),
  api_contract: ApiContractSchema.optional(),
  data_model_changes: z.string().optional(),
  test_scenarios: z.array(TestScenarioSchema),
  dependencies: z.array(RepoDependencySchema),
  open_questions: z.array(z.string()),
})

export const TechnicalPRDsSchema = z.record(z.string(), TechnicalRepoPRDSchema)

// ─── Repo Context (used by agents) ───────────────────────────────────────────

export const RepoContextSchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(['golang', 'python', 'ruby', 'frontend', 'mobile', 'agent', 'unknown']),
  claude_md: z.string().optional(),
  manifest: z.string().optional(),    // package.json / go.mod / pyproject.toml content
  directory_tree: z.string().optional(),
})

// ─── Task ─────────────────────────────────────────────────────────────────────

export const TaskStatusSchema = z.enum(['queued', 'refining', 'refined', 'approved'])
export const TaskTypeSchema = z.enum(['functional', 'technical'])

export const TaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  type: TaskTypeSchema,
  repos: z.array(z.string()),
  status: TaskStatusSchema,
  prd: z.union([FunctionalPRDSchema, TechnicalPRDsSchema]).optional(),
  created_at: z.string(),
  approved_at: z.string().optional(),
  error: z.string().optional(),
})

// ─── Repo Registry Entry ─────────────────────────────────────────────────────

export const RepoEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  type: RepoContextSchema.shape.type,
})

// ─── Provider Config ─────────────────────────────────────────────────────────

export const StepTypeSchema = z.enum(['refine-functional', 'refine-technical', 'implement'])

export const AnthropicApiSettingsSchema = z.object({
  model: z.string(),
  anthropicVersion: z.string(),
  anthropicBeta: z.array(z.string()),
  systemPrompt: z.array(z.object({ type: z.literal('text'), text: z.string() })),
  thinking: z
    .object({
      type: z.enum(['enabled', 'adaptive']),
      budget_tokens: z.number().optional(),
    })
    .optional(),
  stream: z.boolean().optional(),
  responseLanguage: z.string().optional(),
})

export const StepOverrideSchema = AnthropicApiSettingsSchema.partial().extend({
  provider: z.string(),
})

export const StepConfigSchema = z.union([z.string(), StepOverrideSchema])

export const ProviderConfigSchema = z.object({
  steps: z.record(StepTypeSchema, StepConfigSchema),
  anthropicApi: AnthropicApiSettingsSchema,
})
