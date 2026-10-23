/** Las queries GraphQL de `GithubTaskReader`: lo que pide a GitHub, separado de cómo lo lee. */

const PROJECT = 'project { number owner { ... on Organization { login } ... on User { login } } }'

const FIELD_VALUES = `fieldValues(first: 30) {
  nodes {
    ... on ProjectV2ItemFieldSingleSelectValue {
      name
      field { ... on ProjectV2SingleSelectField { name } }
    }
  }
}`

export const ITEMS_OF_ISSUE = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) { projectItems(first: 50) { nodes { id ${PROJECT} ${FIELD_VALUES} } } }
  }
}`

export const ISSUE_OF_ITEM = `query($id: ID!) {
  node(id: $id) {
    ... on ProjectV2Item {
      ${PROJECT}
      content { ... on Issue { number repository { name owner { login } } } }
    }
  }
}`

// La sección "Development" del issue: las ramas vinculadas (`createLinkedBranch`) y los PRs
// abiertos que lo cierran. Una rama que subió el agente sin vincular sólo aparece por su PR.
// `state`: `includeClosedPrs: false` no saca a los mergeados, y la rama de uno ya no es la de la task.
export const LINKED_BRANCHES = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      linkedBranches(first: 10) { nodes { ref { name } } }
      closedByPullRequestsReferences(first: 10, includeClosedPrs: false) {
        nodes { number state headRefName isCrossRepository createdAt repository { nameWithOwner } }
      }
    }
  }
}`

// Las relaciones issue ↔ PR que GitHub ya lleva (sección "Development" y palabras de cierre): el
// intake las lee, no las deduce del nombre de una rama.
export const CLOSING_ISSUES = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    defaultBranchRef { name }
    pullRequest(number: $number) {
      body
      baseRefName
      closingIssuesReferences(first: 10) { nodes { number repository { name owner { login } } } }
    }
  }
}`

// La épica de un issue: su padre en la jerarquía de sub-issues de GitHub.
export const PARENT = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) { parent { number repository { name owner { login } } } }
  }
}`

export const CLOSING_PRS = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      closedByPullRequestsReferences(first: 10, includeClosedPrs: false) { nodes { number state } }
      linkedBranches(first: 10) {
        nodes { ref { associatedPullRequests(states: OPEN, first: 1) { nodes { number } } } }
      }
    }
  }
}`

export const REVIEW_THREADS = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(last: 30) {
        nodes {
          id isResolved path line
          comments(first: 20) { nodes { body createdAt author { login } } }
        }
      }
    }
  }
}`
