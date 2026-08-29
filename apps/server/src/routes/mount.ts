// El set completo de routers de la API, en un solo lugar.
//
// Existe porque lo montan DOS flavors: `full` siempre, y `runner` cuando su
// config declara `api: full` — que es lo que hace que un deploy headless
// siga siendo visible desde `apps/web`. La feature de "servers" de la web
// barre puertos y sondea `GET /api/projects` en cada uno
// (`features/servers/api.ts`), así que un runner sin esa ruta desaparece del
// selector aunque esté corriendo perfectamente.
//
// Duplicar las 24 líneas en cada flavor garantizaba que la próxima ruta se
// agregara en uno solo y el otro quedara silenciosamente atrás.
import type { Hono } from 'hono'
import { createGithubRouter } from '../adapters/github/routes.js'
import { assistWithAiUseCase, systemPromptRepo } from '../composition/container.js'
import { createAgentsCrudRouter } from './agents-crud.js'
import { createAgentsRouter } from './agents.js'
import { createEnvVarsRouter } from './env-vars.js'
import { createExecutionsRouter } from './executions.js'
import { createHookEventsRouter } from './hook-events.js'
import { createMcpCatalogRouter } from './mcp-catalog.js'
import { createMcpRouter } from './mcp.js'
import { createProjectConfigRouter } from './project-config.js'
import { createProjectSourceRouter } from './project-source.js'
import { createProjectsRouter } from './projects.js'
import { createProviderRegistrationsRouter } from './provider-registrations.js'
import { createProvidersRouter } from './providers.js'
import { createRemoteExecutionsRouter } from './remote-executions.js'
import { createRemoteLogsRouter } from './remote-logs.js'
import { createRulesRouter } from './rules.js'
import { createServerLogsRouter } from './server-logs.js'
import { createSlackRouter } from './slack.js'
import { createStatusesRouter } from './statuses.js'
import { createSystemPromptsRouter } from './system-prompts.js'
import { createReposRouter, createTasksRouter } from './tasks.js'
import { createToolsRouter } from './tools.js'
import { createVariablesRouter } from './variables.js'
import { createWebhooksRouter } from './webhooks.js'

/**
 * Monta todo salvo `/api/webhooks`, que va aparte: el flavor `runner` lo
 * necesita SIEMPRE (es su razón de ser) y el resto sólo bajo `api: full`.
 */
export function mountApiRoutes(app: Hono, broadcastFn: (msg: object) => void): void {
  app.route('/api/tasks', createTasksRouter(broadcastFn))
  app.route('/api/repos', createReposRouter())
  app.route('/api/providers', createProvidersRouter())
  app.route('/api/provider-registrations', createProviderRegistrationsRouter())
  app.route('/api/projects', createProjectsRouter(systemPromptRepo))
  app.route('/api/projects/:id/source', createProjectSourceRouter())
  app.route('/api/project-config', createProjectConfigRouter())
  app.route('/api/github', createGithubRouter())
  app.route('/api/tools', createToolsRouter())
  app.route('/api/mcp', createMcpRouter())
  app.route('/api/agents', createAgentsRouter(assistWithAiUseCase))
  app.route('/api/agents-crud', createAgentsCrudRouter())
  app.route('/api/rules', createRulesRouter())
  app.route('/api/system-prompts', createSystemPromptsRouter())
  app.route('/api/statuses', createStatusesRouter())
  app.route('/api/env-vars', createEnvVarsRouter())
  app.route('/api/slack', createSlackRouter())
  app.route('/api/variables', createVariablesRouter())
  app.route('/api/mcp-catalog', createMcpCatalogRouter())
  app.route('/api/executions', createExecutionsRouter())
  app.route('/api/server-logs', createServerLogsRouter())
  app.route('/api/hook-events', createHookEventsRouter())
  app.route('/api/remote-logs', createRemoteLogsRouter())
  app.route('/api/remote-executions', createRemoteExecutionsRouter())
}

export { createWebhooksRouter }
