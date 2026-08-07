import type { z } from 'zod'
import type {
  AcceptanceCriterionSchema,
  AgentDefinitionSchema,
  AgentProviderConfigSchema,
  AnthropicApiAgentConfigSchema,
  AnthropicApiSettingsSchema,
  ApiContractSchema,
  FileToModifySchema,
  FunctionalPRDSchema,
  GitHubManagerConfigSchema,
  ImpactedRepoSchema,
  LocalManagerConfigSchema,
  ManagerConfigSchema,
  PhasePromptsSchema,
  ProjectConfigSchema,
  ProjectSettingsSchema,
  ProviderConfigSchema,
  RepoContextSchema,
  RepoDependencySchema,
  RepoEntrySchema,
  RepoMappingEntrySchema,
  RepoMappingSchema,
  RepoMappingValueSchema,
  RepoWorkflowSchema,
  StatusAgentEntrySchema,
  StatusConfigSchema,
  StepConfigSchema,
  StepOverrideSchema,
  StepTypeSchema,
  TaskSchema,
  TaskStatusSchema,
  TaskTypeSchema,
  TechnicalPRDsSchema,
  TechnicalRepoPRDSchema,
  TerminalAgentConfigSchema,
  TestScenarioSchema,
  UserStorySchema,
  WhenConditionSchema,
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
export type RepoWorkflow = z.infer<typeof RepoWorkflowSchema>
export type AnthropicApiSettings = z.infer<typeof AnthropicApiSettingsSchema>
export type StepType = z.infer<typeof StepTypeSchema>
export type StepConfig = z.infer<typeof StepConfigSchema>
export type StepOverride = z.infer<typeof StepOverrideSchema>
export type PhasePrompts = z.infer<typeof PhasePromptsSchema>
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>
export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>
export type AgentProviderConfig = z.infer<typeof AgentProviderConfigSchema>
export type AnthropicApiAgentConfig = z.infer<typeof AnthropicApiAgentConfigSchema>
export type TerminalAgentConfig = z.infer<typeof TerminalAgentConfigSchema>
export type StatusConfig = z.infer<typeof StatusConfigSchema>
export type StatusAgentEntry = z.infer<typeof StatusAgentEntrySchema>
export type ManagerConfig = z.infer<typeof ManagerConfigSchema>
export type LocalManagerConfig = z.infer<typeof LocalManagerConfigSchema>
export type GitHubManagerConfig = z.infer<typeof GitHubManagerConfigSchema>

// WebSocket message types
export type WsMessage =
  | { type: 'task:created'; task: Task }
  | { type: 'task:updated'; task: Task }
  | { type: 'task:approved'; task: Task }
  | { type: 'tasks:snapshot'; tasks: Task[] }
