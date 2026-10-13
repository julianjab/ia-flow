import { describe, expect, test } from 'bun:test'
import { formatAnthropicRequest } from './gatewayLog.js'

describe('formatAnthropicRequest', () => {
  const out = formatAnthropicRequest({
    url: 'https://api.anthropic.com/v1/messages',
    headers: {
      'content-type': 'application/json',
      Authorization: 'Bearer secreto-oauth-123',
      'x-api-key': 'sk-ant-otro',
      'anthropic-beta': 'oauth-2025-04-20',
    },
    body: { model: 'claude-x', system: [{ type: 'text', text: 'hola' }] },
  })

  test('muestra url, headers y body completo', () => {
    expect(out).toContain('POST https://api.anthropic.com/v1/messages')
    expect(out).toContain('anthropic-beta: oauth-2025-04-20')
    expect(out).toContain('body: {"model":"claude-x","system":[{"type":"text","text":"hola"}]}')
  })

  test('enmascara la credencial: esquema y largo, nunca el valor', () => {
    expect(out).toContain('Authorization: Bearer (17 chars)')
    expect(out).toContain('x-api-key: (11 chars)')
    expect(out).not.toContain('secreto-oauth-123')
    expect(out).not.toContain('sk-ant-otro')
  })
})
