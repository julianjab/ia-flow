// Re-exports the canonical contract from @ia-flow/issue-sources. Extracted
// there as part of the composable-engine refactor
// (docs/prd/composable-engine-refactor.md).
export type {
  ProjectSource,
  StatusOption,
  SourceProjectField,
  SourceItem,
  CreateItemInput,
  UpdateItemInput,
  WebhookMatchHint,
  Blocker,
  SourceHealthField,
  SourceHealth,
} from '@ia-flow/issue-sources'
export { defaultToIssueItem } from '@ia-flow/issue-sources'
