// Leer una task de un board de GitHub (`GithubTaskReader`) y darle forma — el issue, la card, el
// PR abierto y su timeline (`{{task.comments}}`, `{{task.ci}}`).
export type { BoardRef, RawTaskContext } from './GithubTaskReader.js'
export { GithubTaskReader } from './GithubTaskReader.js'
export type { Card, OpenPr, RawIssueRef, RawItem, RawPr } from './shapes.js'
export { boardItem, issueRefs, openPr } from './shapes.js'
export type { Stack, StackBase, StackBlocker } from './stack.js'
export { stackOf } from './stack.js'
export type { RawComment, RawReview, RawThread } from './timeline.js'
export {
  formatComments,
  isCancelledCheck,
  isRedCheck,
  latestCheckRuns,
  RED_CHECK_CONCLUSIONS,
  rollupCi,
  taskTimeline,
} from './timeline.js'
