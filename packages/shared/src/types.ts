import type { z } from 'zod'
import type {
  TaskSchema,
  TaskStatusSchema,
  TaskTypeSchema,
  FunctionalPRDSchema,
  TechnicalPRDsSchema,
  TechnicalRepoPRDSchema,
  RepoContextSchema,
  RepoEntrySchema,
  UserStorySchema,
  AcceptanceCriterionSchema,
  ImpactedRepoSchema,
  FileToModifySchema,
  ApiContractSchema,
  TestScenarioSchema,
  RepoDependencySchema,
  ProviderConfigSchema,
  RepoMappingSchema,
  RepoMappingEntrySchema,
  RepoMappingValueSchema,
  RepoWorkflowSchema,
  AnthropicApiSettingsSchema,
  StepTypeSchema,
  StepConfigSchema,
  StepOverrideSchema,
  PhasePromptsSchema,
} from './schemas.js'

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
export type RepoMapping = z.infer<typeof RepoMappingSchema>
export type RepoMappingEntry = z.infer<typeof RepoMappingEntrySchema>
export type RepoMappingValue = z.infer<typeof RepoMappingValueSchema>
export type RepoWorkflow = z.infer<typeof RepoWorkflowSchema>
export type AnthropicApiSettings = z.infer<typeof AnthropicApiSettingsSchema>
export type StepType = z.infer<typeof StepTypeSchema>
export type StepConfig = z.infer<typeof StepConfigSchema>
export type StepOverride = z.infer<typeof StepOverrideSchema>
export type PhasePrompts = z.infer<typeof PhasePromptsSchema>

// WebSocket message types
export type WsMessage =
  | { type: 'task:created'; task: Task }
  | { type: 'task:updated'; task: Task }
  | { type: 'task:approved'; task: Task }
  | { type: 'tasks:snapshot'; tasks: Task[] }
