/**
 * Slack: leer un hilo o un canal y publicar (`@ia-flow/slack-tools`), y pedir review del PR de la
 * task (`request_slack_review`). Todas usan el bot token de `SLACK_BOT_TOKEN`; sin él, fallan al
 * llamarlas diciendo por qué.
 */

import {
  SlackChannelHistoryAction,
  SlackPostMessageAction,
  SlackReadThreadAction,
} from '@ia-flow/slack-tools'
import { defineAction, SlackReviewSchema } from '../defineAction.js'
import { RequestSlackReviewAction } from '../RequestSlackReviewAction.js'
import { projectOf } from './project.js'

export default [
  defineAction({
    id: 'slack_read_thread',
    create: (ctx) => new SlackReadThreadAction(ctx.services.slack),
  }),
  defineAction({
    id: 'slack_channel_history',
    create: (ctx) => new SlackChannelHistoryAction(ctx.services.slack),
  }),
  defineAction({
    id: 'slack_post_message',
    create: (ctx) => new SlackPostMessageAction(ctx.services.slack),
  }),
  defineAction({
    id: 'request_slack_review',
    create: (ctx) => {
      const project = projectOf(ctx, 'request_slack_review')
      return new RequestSlackReviewAction({
        github: ctx.services.github,
        slack: ctx.services.slack,
        users: ctx.services.slackUsers,
        project: project.slackReview,
        // Un repo del catálogo puede traer `slackReviewChannel`/`slackReviewers`/`slackReviewMessage`.
        repo: (owner, repo) => {
          const entry = project.repos.find(
            (candidate) => candidate.githubOwner === owner && candidate.githubRepo === repo,
          )
          return entry ? SlackReviewSchema.parse(entry) : undefined
        },
      })
    },
  }),
]
