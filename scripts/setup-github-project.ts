#!/usr/bin/env bun
// One-time script: creates the ia-flow GitHub Project in the la-haus org
// Usage: GITHUB_TOKEN=ghp_xxx bun run scripts/setup-github-project.ts
//
// Required token scopes: project, repo, read:org

const token = process.env.GITHUB_TOKEN
if (!token) {
  console.error('❌ GITHUB_TOKEN is required')
  process.exit(1)
}

const ORG = 'la-haus'
const PROJECT_TITLE = 'ia-flow — Dev Pipeline'

async function gql<T = unknown>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'ia-flow-setup/1.0',
    },
    body: JSON.stringify({ query, variables }),
  })
  const json = (await res.json()) as any
  if (json.errors?.length) throw new Error(json.errors.map((e: any) => e.message).join('; '))
  return json.data
}

// 1. Get org node id
async function resolveOrgId(): Promise<string> {
  console.log(`\n🔍 Resolving org: ${ORG}`)
  const orgData = await gql<any>(`query($org: String!) { organization(login: $org) { id } }`, {
    org: ORG,
  })
  const orgId = orgData.organization.id
  console.log(`   org id: ${orgId}`)
  return orgId
}

// 2. Create project
async function createProject(orgId: string) {
  console.log(`\n📋 Creating project: "${PROJECT_TITLE}"`)
  const createData = await gql<any>(
    `mutation($ownerId: ID!, $title: String!) {
      createProjectV2(input: { ownerId: $ownerId, title: $title }) {
        projectV2 { id url number }
      }
    }`,
    { ownerId: orgId, title: PROJECT_TITLE },
  )
  const {
    id: projectId,
    url: projectUrl,
    number: projectNumber,
  } = createData.createProjectV2.projectV2
  console.log(`   ✅ Project #${projectNumber}: ${projectUrl}`)
  console.log(`   id: ${projectId}`)
  return { projectId, projectUrl, projectNumber }
}

// 3. Get the auto-created Status field id (and the rest of the existing fields)
async function loadFields(projectId: string) {
  console.log(`\n📊 Loading fields...`)
  const fieldsData = await gql<any>(
    `query($id: ID!) {
      node(id: $id) {
        ... on ProjectV2 {
          fields(first: 20) {
            nodes {
              ... on ProjectV2SingleSelectField { id name options { id name } }
              ... on ProjectV2Field { id name dataType }
            }
          }
        }
      }
    }`,
    { id: projectId },
  )
  const existingFields: any[] = fieldsData.node.fields.nodes
  const statusField = existingFields.find((f) => f.name === 'Status')
  console.log(`   existing fields: ${existingFields.map((f) => f.name).join(', ')}`)
  return { existingFields, statusField }
}

// 4. Update Status field options (add our pipeline stages)
async function configureStatusStages(statusField: any) {
  const STAGES = ['Backlog', 'Queue', 'Refining', 'Refined', 'Approved', 'In Review', 'Done']
  if (!statusField) return

  console.log(`\n🔄 Configuring Status field stages...`)
  const existing = statusField.options?.map((o: any) => o.name) ?? []

  for (const stage of STAGES) {
    if (existing.includes(stage)) {
      console.log(`   ⏭️  "${stage}" already exists`)
      continue
    }
    try {
      await gql(
        `mutation($projectId: ID!, $fieldId: ID!, $name: String!, $color: ProjectV2SingleSelectFieldOptionColor!, $description: String!) {
          createProjectV2Field(input: {}) { clientMutationId }
        }`,
        {},
      )
      // Note: Adding options to existing single-select fields requires updateProjectV2Field
      // which is currently limited in the API. Stages must be added manually in the UI
      // after creation, or via the REST API workaround below.
      console.log(`   ⚠️  "${stage}" — add manually in GitHub UI (API limitation)`)
    } catch {
      console.log(`   ⚠️  "${stage}" — add manually in GitHub UI`)
    }
  }
}

async function createTextField(projectId: string, name: string) {
  await gql(
    `mutation($projectId: ID!, $name: String!, $dataType: ProjectV2CustomFieldType!) {
      createProjectV2Field(input: { projectId: $projectId, name: $name, dataType: $dataType }) {
        projectV2Field { ... on ProjectV2Field { id name } }
      }
    }`,
    { projectId, name, dataType: 'TEXT' },
  )
}

async function createSingleSelectField(projectId: string, name: string, options: string[]) {
  const singleSelectInputOptions = options.map((o) => ({
    name: o,
    color: 'GRAY',
    description: '',
  }))
  await gql(
    `mutation($projectId: ID!, $name: String!, $dataType: ProjectV2CustomFieldType!, $singleSelectOptions: [ProjectV2SingleSelectFieldOptionInput!]!) {
      createProjectV2Field(input: {
        projectId: $projectId
        name: $name
        dataType: $dataType
        singleSelectOptions: $singleSelectOptions
      }) {
        projectV2Field { ... on ProjectV2SingleSelectField { id name options { id name } } }
      }
    }`,
    {
      projectId,
      name,
      dataType: 'SINGLE_SELECT',
      singleSelectOptions: singleSelectInputOptions,
    },
  )
}

// 5. Create custom fields
async function createCustomFields(projectId: string, existingFields: any[]) {
  const CUSTOM_FIELDS = [
    {
      name: 'Type',
      dataType: 'SINGLE_SELECT',
      options: ['functional', 'technical', 'bug', 'spike', 'hotfix'],
    },
    { name: 'Repos', dataType: 'TEXT' },
    { name: 'Priority', dataType: 'SINGLE_SELECT', options: ['P0', 'P1', 'P2', 'P3'] },
    { name: 'Size', dataType: 'SINGLE_SELECT', options: ['XS', 'S', 'M', 'L', 'XL'] },
    { name: 'Agent', dataType: 'TEXT' },
  ]

  console.log(`\n🏷️  Creating custom fields...`)
  for (const field of CUSTOM_FIELDS) {
    const exists = existingFields.find((f) => f.name === field.name)
    if (exists) {
      console.log(`   ⏭️  ${field.name} already exists`)
      continue
    }
    try {
      if (field.dataType === 'TEXT') {
        await createTextField(projectId, field.name)
      } else {
        await createSingleSelectField(projectId, field.name, field.options ?? [])
      }
      console.log(`   ✅ Created field: ${field.name}`)
    } catch (err) {
      console.log(`   ⚠️  ${field.name}: ${(err as Error).message}`)
    }
  }
}

// 6. Done — print next steps
function printNextSteps(projectUrl: string) {
  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ Project created!

Project URL: ${projectUrl}

Next steps:
  1. In ia-flow web UI, create a project and set its "GitHub Project URL"
     to the URL above.
  2. Configure GITHUB_TOKEN in Settings → Env vars (or apps/server/.env).

Manual steps in GitHub UI (${projectUrl}):
  1. Status field: add stages in order:
     Backlog → Queue → Refining → Refined → Approved → In Review → Done
  2. Set "Queue" as the trigger stage (move items here to start refinement)
  3. Share the project with your team

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`)
}

async function main() {
  const orgId = await resolveOrgId()
  const { projectId, projectUrl } = await createProject(orgId)
  const { existingFields, statusField } = await loadFields(projectId)
  await configureStatusStages(statusField)
  await createCustomFields(projectId, existingFields)
  printNextSteps(projectUrl)
}

main().catch((err) => {
  console.error('❌ Setup failed:', err.message)
  process.exit(1)
})
