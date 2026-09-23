import type { Task } from '../domain/Task.js'
import { Step, type StepContext } from './Step.js'

/** Un `do` que no es un Agent: transicionar status, comentar, postear a Slack, etc.
 *  Cada acción concreta declara su propio TIn/TOut — la cadena de la Rule no le
 *  exige una forma común más allá de `run`. */
export abstract class Action<TIn = unknown, TOut = unknown> extends Step<TIn, TOut> {
  readonly kind = 'action'
  abstract readonly id: string
}

export interface TransitionInput {
  task: Task
}

export class TransitionAction extends Action<TransitionInput, void> {
  readonly id = 'transition'
  readonly name = 'transition'
  readonly toStatus: string

  constructor(toStatus: string) {
    super()
    this.toStatus = toStatus
  }

  async run(input: TransitionInput, ctx: StepContext): Promise<void> {
    throw new Error(
      'not implemented — task.transitionTo(this.toStatus) + persistir vía ITaskSource',
    )
  }
}

export interface CommentInput {
  task: Task
  body: string
}

export class CommentAction extends Action<CommentInput, void> {
  readonly id = 'comment'
  readonly name = 'comment'
  readonly target: 'issue' | 'pr' | 'pr-else-issue'

  constructor(target: 'issue' | 'pr' | 'pr-else-issue' = 'pr-else-issue') {
    super()
    this.target = target
  }

  async run(input: CommentInput, ctx: StepContext): Promise<void> {
    throw new Error('not implemented — resolveCommentTarget + post vía ITaskSource')
  }
}
