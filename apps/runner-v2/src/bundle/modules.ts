/**
 * Los paquetes que el runner (`register.ts`, al arrancar) les sirve a las actions de la config como
 * módulos virtuales — con los MISMOS objetos que usa el runner. Una action que importe un paquete
 * que no está acá falla al arrancar con "Cannot find package" (y `dist-modules.test.ts` lo avisa
 * antes, contra la `.config` del repo).
 */
import * as agentEngine from '@ia-flow/agent-engine'
import * as agentEngineDatasourceYaml from '@ia-flow/agent-engine-datasource-yaml'
import * as agentEngineDefinitions from '@ia-flow/agent-engine-definitions'
import * as githubApi from '@ia-flow/github-api'
import * as githubAuth from '@ia-flow/github-auth'
import * as githubTools from '@ia-flow/github-tools'
import * as githubWebhook from '@ia-flow/github-webhook'
import * as providerShared from '@ia-flow/provider-shared'
import * as shared from '@ia-flow/shared'
import * as slackApi from '@ia-flow/slack-api'
import * as slackTools from '@ia-flow/slack-tools'
import * as telemetry from '@ia-flow/telemetry'
import * as workspace from '@ia-flow/workspace'
import * as yaml from 'yaml'
import * as zod from 'zod'
import * as runnerActions from '../actions/defineAction.js'

export const VIRTUAL_MODULES: Record<string, Record<string, unknown>> = {
  '@ia-flow/agent-engine': agentEngine,
  '@ia-flow/agent-engine-datasource-yaml': agentEngineDatasourceYaml,
  '@ia-flow/agent-engine-definitions': agentEngineDefinitions,
  '@ia-flow/github-api': githubApi,
  '@ia-flow/github-auth': githubAuth,
  '@ia-flow/github-tools': githubTools,
  '@ia-flow/github-webhook': githubWebhook,
  '@ia-flow/provider-shared': providerShared,
  '@ia-flow/runner-v2/actions': runnerActions,
  '@ia-flow/shared': shared,
  '@ia-flow/slack-api': slackApi,
  '@ia-flow/slack-tools': slackTools,
  '@ia-flow/telemetry': telemetry,
  '@ia-flow/workspace': workspace,
  yaml,
  zod,
}
