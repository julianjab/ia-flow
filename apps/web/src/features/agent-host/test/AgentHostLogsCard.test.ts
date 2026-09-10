import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import AgentHostLogsCard from '../AgentHostLogsCard.vue'
import type { AgentHostLogTail } from '../api'

function tail(time: string): AgentHostLogTail {
  return {
    file: '/tmp/agent-host.log',
    lines: [{ raw: '{}', time, level: 30, scope: 'agent-host', msg: 'ready' }],
    truncated: false,
  }
}

/** El mismo instante, escrito como lo escribe pino (`isoTime`, en UTC). */
function isoAt(d: Date): string {
  return d.toISOString()
}

describe('AgentHostLogsCard', () => {
  it('muestra la hora LOCAL, no el UTC del archivo', () => {
    const at = new Date()
    at.setHours(3, 4, 5, 0)
    const wrapper = mount(AgentHostLogsCard, { props: { tail: tail(isoAt(at)) } })

    expect(wrapper.find('.line__time').text()).toBe('03:04:05')
  })

  it('agrega la fecha cuando la línea no es de hoy', () => {
    const at = new Date()
    at.setDate(at.getDate() - 1)
    at.setHours(10, 37, 24, 0)
    const wrapper = mount(AgentHostLogsCard, { props: { tail: tail(isoAt(at)) } })

    // Una línea de ayer leída como `10:37:24` se confunde con una de hoy.
    expect(wrapper.find('.line__time').text()).toMatch(/^\d{2} \w+\.? 10:37:24$/)
  })
})
