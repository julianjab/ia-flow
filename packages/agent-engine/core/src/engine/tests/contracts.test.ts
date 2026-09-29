import { createEvent } from '../../events/DomainEvent.js'
import { FunctionAction } from '../../pipeline/actions/FunctionAction.js'
import { Pipeline } from '../../pipeline/Pipeline.js'
import { executionStoreContract, pipelineSourceContract } from '../../testing/index.js'
import { InMemoryExecutionStore } from '../InMemoryExecutionStore.js'
import { StaticPipelineSource } from '../PipelineSource.js'

const noop = () => new FunctionAction({ fn: () => undefined })

executionStoreContract('InMemoryExecutionStore', (options) => new InMemoryExecutionStore(options))

pipelineSourceContract('StaticPipelineSource', () => ({
  source: new StaticPipelineSource([
    new Pipeline({ id: 'a', on: ['build'], do: [noop()] }),
    new Pipeline({ id: 'b', on: ['build'], position: 1, do: [noop()] }),
    new Pipeline({ id: 'c', on: ['other'], do: [noop()] }),
  ]),
  matching: createEvent('build', {}),
  expected: ['a', 'b'],
  nonMatching: createEvent('nobody', {}),
}))

pipelineSourceContract('StaticPipelineSource with an id and defaults', () => ({
  source: new StaticPipelineSource([new Pipeline({ id: 'build', on: ['build'], do: [noop()] })], {
    id: 'p',
    defaults: { report: null },
  }),
  matching: createEvent('build', {}),
  expected: ['build'],
  nonMatching: createEvent('nobody', {}),
}))
