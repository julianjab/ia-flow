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

// How the implementation step should stage changes for this repo:
//   'worktree' — create a git worktree in a sibling directory (safe parallel work)
//   'branch'   — create a new branch in-place on the repo checkout
//   'main'     — commit directly on the default branch (no isolation)
export const RepoWorkflowSchema = z.enum(['worktree', 'branch', 'main'])

// ─── Repo Context (used by agents) ───────────────────────────────────────────

export const RepoContextSchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(['golang', 'python', 'ruby', 'frontend', 'mobile', 'agent', 'unknown']),
  workflow: RepoWorkflowSchema.optional(),
  claude_md: z.string().optional(),
  manifest: z.string().optional(), // package.json / go.mod / pyproject.toml content
  directory_tree: z.string().optional(),
})

// ─── Task ─────────────────────────────────────────────────────────────────────

export const TaskStatusSchema = z.enum(['queued', 'refining', 'refined', 'approved'])
export const TaskTypeSchema = z.enum(['functional', 'technical'])

export const TaskCommentSchema = z.object({
  body: z.string(),
  created_at: z.string(),
})

export const TaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  type: TaskTypeSchema,
  repos: z.array(z.string()),
  // Widened to string: runtime uses GitHub Project column names (e.g. "Done", "Refined")
  // in addition to the legacy enum values. Use TaskStatusSchema to validate the enum subset.
  status: z.string(),
  prd: z.union([FunctionalPRDSchema, TechnicalPRDsSchema]).optional(),
  sections: z.record(z.string(), z.string()).optional(),
  created_at: z.string(),
  approved_at: z.string().optional(),
  error: z.string().optional(),
  agent_working: z.boolean().optional(),
  issueNumber: z.number().optional(),
  issueUrl: z.string().optional(),
  comments: z.array(TaskCommentSchema).optional(),
  // Which ia-flow project this task belongs to. Set by the manager that polled
  // the source (github/local) so the dispatcher can resolve project-scoped
  // statuses and agents. Optional to keep legacy single-tenant callers working.
  projectId: z.string().optional(),
})

// ─── Repo Registry Entry ─────────────────────────────────────────────────────

export const RepoEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  type: RepoContextSchema.shape.type,
  hasGit: z.boolean().optional(),
  workflow: RepoWorkflowSchema.optional(),
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
  maxIters: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
})

export const TerminalProviderSettingsSchema = z.object({
  model: z.string().optional(),
  dangerouslySkipPermissions: z.boolean().optional(),
  env: z.record(z.string(), z.string()).optional(),
})
export type TerminalProviderSettings = z.infer<typeof TerminalProviderSettingsSchema>

export const StepOverrideSchema = AnthropicApiSettingsSchema.partial().extend({
  provider: z.string(),
})

export const StepConfigSchema = z.union([z.string(), StepOverrideSchema])

// Repo mapping entry — resolves a local repo name to its GitHub coordinates.
// Shorthand string form: value is the GitHub repo name (owner stays default).
// Object form: override owner, repo, and/or the full local path.
export const RepoMappingEntrySchema = z.object({
  githubOwner: z.string().optional(),
  githubRepo: z.string().optional(),
  path: z.string().optional(),
  workflow: RepoWorkflowSchema.optional(),
})

export const RepoMappingValueSchema = z.union([z.string(), RepoMappingEntrySchema])

// Maps local repo directory name → mapping entry.
export const RepoMappingSchema = z.record(z.string(), RepoMappingValueSchema)

export const PhasePromptsSchema = z.record(StepTypeSchema, z.string())

export const ProviderConfigSchema = z.object({
  steps: z.record(StepTypeSchema, StepConfigSchema),
  anthropicApi: AnthropicApiSettingsSchema,
  tmuxClaude: TerminalProviderSettingsSchema.optional(),
  itermClaude: TerminalProviderSettingsSchema.optional(),
  repoMappings: RepoMappingSchema.optional(),
  phasePrompts: PhasePromptsSchema.optional(),
  fileSimplifierPrompt: z.string().optional(),
  compactionPrompt: z.string().optional(),
})

// ─── Project Config (status-based agent state machine) ───────────────────────

export const ProjectSettingsSchema = z.object({
  name: z.string().optional(),
  language: z.string().optional(),
})

// ─── Multi-tenant Project (row in `projects` table) ──────────────────────
// A project is the top-level container that groups statuses (required),
// managers (embedded in settings for now), and optionally overrides global
// agents / system prompts via `projectId`.

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  githubProjectUrl: z.string().nullable().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  archivedAt: z.string().nullable().optional(),
})

export const SystemPromptDefSchema = z.object({
  id: z.string(),
  name: z.string(),
  text: z.string(),
  // null / undefined = global (visible in every project)
  projectId: z.string().nullable().optional(),
})
export type SystemPromptDef = z.infer<typeof SystemPromptDefSchema>

// ─── Per-Agent Provider Config ───────────────────────────────────────────
// Discriminated union: shape depends on which provider the agent uses.
// Strict per variant → extra fields (e.g. terminal flags on an API agent) are rejected.

export const AnthropicApiAgentConfigSchema = z
  .object({
    provider: z.literal('anthropic-api'),
    model: z.string().optional(),
    maxTokens: z.number().int().positive().optional(),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
    taskBudgetTokens: z.number().int().min(20000).optional(),
    maxIters: z.number().int().positive().optional(),
  })
  .strict()

export const TerminalAgentConfigSchema = z.object({
  model: z.string().optional(),
  dangerouslySkipPermissions: z.boolean().optional(),
})

const TmuxClaudeAgentConfigSchema = TerminalAgentConfigSchema.extend({
  provider: z.literal('tmux-claude'),
}).strict()
const ItermClaudeAgentConfigSchema = TerminalAgentConfigSchema.extend({
  provider: z.literal('iterm-claude'),
}).strict()

export const AgentProviderConfigSchema = z.discriminatedUnion('provider', [
  AnthropicApiAgentConfigSchema,
  TmuxClaudeAgentConfigSchema,
  ItermClaudeAgentConfigSchema,
])

export const AgentVariableValueSchema = z.union([
  z.string(),
  z.object({
    value: z.string(),
    full: z.string().optional(),
    description: z.string().optional(),
  }),
])

export const AgentDefinitionSchema = z.object({
  id: z.string(),
  provider: z.string(),
  prompt: z.string(),
  systemPrompts: z.array(z.string()).optional(),
  variables: z.record(z.string(), AgentVariableValueSchema).optional(),
  tools: z.array(z.string()).optional(),
  save_output: z.boolean().optional(),
  /** @deprecated use `providerConfig.maxIters` instead */
  maxIters: z.number().int().positive().optional(),
  providerConfig: AgentProviderConfigSchema.optional(),
  // null / undefined = global (visible in every project)
  projectId: z.string().nullable().optional(),
})

export const AgentContextConfigSchema = z.object({
  repos: z.union([z.literal('task'), z.literal('all'), z.array(z.string())]).optional(),
})

export const WhenConditionSchema = z.object({
  field: z.string(),
  op: z.string(),
  value: z.string().optional(),
  logic: z.enum(['and', 'or']).optional(),
})

export const StatusAgentEntrySchema = z.object({
  agent: z.string(),
  // new: array of conditions with per-entry logic; legacy: flat record (all-AND)
  when: z.union([z.array(WhenConditionSchema), z.record(z.string(), z.string())]).optional(),
  onProcess: z.string().optional(),
  onFinish: z.string().optional(),
  onError: z.string().optional(),
})

export const StatusConfigSchema = z.object({
  name: z.string(),
  context: AgentContextConfigSchema.optional(),
  agents: z.array(StatusAgentEntrySchema),
  // Required at the DB layer; optional in the schema so legacy imports
  // (e.g. `ProjectConfig` YAML paste) resolve it from the target project.
  projectId: z.string().optional(),
})

// ─── Manager Config (plugin-style issue source registry) ─────────────────────

export const LocalManagerConfigSchema = z.object({
  type: z.literal('local'),
  // Optional — a local manager can be shared across projects, or scoped to one.
  projectId: z.string().optional(),
})
export const GitHubManagerConfigSchema = z.object({
  type: z.literal('github'),
  url: z.string(),
  // Which ia-flow project owns this manager. Set when the config is derived
  // from a `projects` row so items dispatched carry the right projectId.
  projectId: z.string().optional(),
})
export const ManagerConfigSchema = z.discriminatedUnion('type', [
  LocalManagerConfigSchema,
  GitHubManagerConfigSchema,
])

export const ProjectConfigSchema = z.object({
  project: ProjectSettingsSchema.optional(),
  systemPrompts: z.array(SystemPromptDefSchema).optional(),
  agents: z.array(AgentDefinitionSchema).optional(),
  statuses: z.array(StatusConfigSchema).optional(),
  scanRoots: z.array(z.string()).optional(),
  managers: z.array(ManagerConfigSchema).optional(),
})
