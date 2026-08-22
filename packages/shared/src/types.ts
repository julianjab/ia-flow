import type { z } from 'zod'
import type {
  AcceptanceCriterionSchema,
  AgentActivationSchema,
  AgentDefinitionSchema,
  AgentOutcomesSchema,
  AgentProviderConfigSchema,
  AnthropicApiSettingsSchema,
  ApiContractSchema,
  FileToModifySchema,
  FunctionalPRDSchema,
  GitHubManagerConfigSchema,
  ImpactedRepoSchema,
  LocalManagerConfigSchema,
  ManagerConfigSchema,
  ProjectConfigSchema,
  ProjectSchema,
  ProjectSettingsSchema,
  ProviderConfigSchema,
  PullRequestRefSchema,
  RepoContextSchema,
  RepoDefSchema,
  RepoDependencySchema,
  RepoEntrySchema,
  RepoLookupResultSchema,
  RepoMappingEntrySchema,
  RepoMappingSchema,
  RepoMappingValueSchema,
  RepoWorkflowSchema,
  SourceRefSchema,
  StatusConfigSchema,
  StepConfigSchema,
  StepOverrideSchema,
  StepTypeSchema,
  TaskSchema,
  TaskStatusSchema,
  TaskTypeSchema,
  TechnicalPRDsSchema,
  TechnicalRepoPRDSchema,
  TestScenarioSchema,
  UserStorySchema,
  WhenConditionSchema,
  YamlGlobalSettingsSchema,
  YamlPromptCatalogSchema,
} from './schemas.js'

export type WhenCondition = z.infer<typeof WhenConditionSchema>
export type Task = z.infer<typeof TaskSchema>
export type TaskStatus = z.infer<typeof TaskStatusSchema>
export type TaskType = z.infer<typeof TaskTypeSchema>
export type FunctionalPRD = z.infer<typeof FunctionalPRDSchema>
export type TechnicalPRDs = z.infer<typeof TechnicalPRDsSchema>
export type TechnicalRepoPRD = z.infer<typeof TechnicalRepoPRDSchema>
export type RepoContext = z.infer<typeof RepoContextSchema>
export type RepoEntry = z.infer<typeof RepoEntrySchema>
export type PullRequestRef = z.infer<typeof PullRequestRefSchema>
export type RepoLookupResult = z.infer<typeof RepoLookupResultSchema>
export type UserStory = z.infer<typeof UserStorySchema>
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>
export type ImpactedRepo = z.infer<typeof ImpactedRepoSchema>
export type FileToModify = z.infer<typeof FileToModifySchema>
export type ApiContract = z.infer<typeof ApiContractSchema>
export type TestScenario = z.infer<typeof TestScenarioSchema>
export type RepoDependency = z.infer<typeof RepoDependencySchema>
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>
export type ItermClaudeSettings = import('./schemas.js').TerminalProviderSettings
export type RepoMapping = z.infer<typeof RepoMappingSchema>
export type RepoMappingEntry = z.infer<typeof RepoMappingEntrySchema>
export type RepoMappingValue = z.infer<typeof RepoMappingValueSchema>
export type RepoDef = z.infer<typeof RepoDefSchema>
export type YamlGlobalSettings = z.infer<typeof YamlGlobalSettingsSchema>
export type YamlPromptCatalog = z.infer<typeof YamlPromptCatalogSchema>
export type RepoWorkflow = z.infer<typeof RepoWorkflowSchema>
export type AnthropicApiSettings = z.infer<typeof AnthropicApiSettingsSchema>
export type StepType = z.infer<typeof StepTypeSchema>
export type StepConfig = z.infer<typeof StepConfigSchema>
export type StepOverride = z.infer<typeof StepOverrideSchema>
export type Project = z.infer<typeof ProjectSchema>
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>
export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>
export type SourceRef = z.infer<typeof SourceRefSchema>
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>
export type AgentProviderConfig = z.infer<typeof AgentProviderConfigSchema>
export type StatusConfig = z.infer<typeof StatusConfigSchema>
export type AgentActivation = z.infer<typeof AgentActivationSchema>
export type AgentOutcomes = z.infer<typeof AgentOutcomesSchema>
export type ManagerConfig = z.infer<typeof ManagerConfigSchema>
export type LocalManagerConfig = z.infer<typeof LocalManagerConfigSchema>
export type GitHubManagerConfig = z.infer<typeof GitHubManagerConfigSchema>

// WebSocket message types
export type WsMessage =
  | { type: 'task:created'; task: Task }
  | { type: 'task:updated'; task: Task }
  | { type: 'task:approved'; task: Task }
  | { type: 'tasks:snapshot'; tasks: Task[] }
