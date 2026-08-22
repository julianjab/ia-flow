import { AxiosError, AxiosHeaders } from 'axios'
import { describe, expect, it } from 'vitest'
import { extractErrorMessage } from '../extractErrorMessage'

function axiosErrorWithBody(status: number, data: unknown): AxiosError {
  const err = new AxiosError('Request failed with status code ' + status)
  err.response = {
    status,
    statusText: '',
    headers: {},
    config: { headers: new AxiosHeaders() },
    data,
  }
  return err
}

describe('extractErrorMessage', () => {
  it('prefiere el campo error del body del server sobre el mensaje genérico de axios', () => {
    const err = axiosErrorWithBody(400, {
      error:
        'YamlAgentRepository es de solo lectura (upsert no soportado) — editá el archivo YAML y reiniciá el proceso.',
    })
    expect(extractErrorMessage(err)).toBe(
      'YamlAgentRepository es de solo lectura (upsert no soportado) — editá el archivo YAML y reiniciá el proceso.',
    )
  })

  it('cae a message del body si no hay error', () => {
    const err = axiosErrorWithBody(500, { message: 'boom' })
    expect(extractErrorMessage(err)).toBe('boom')
  })

  it('cae al message genérico de axios si el body no trae error ni message', () => {
    const err = axiosErrorWithBody(400, {})
    expect(extractErrorMessage(err)).toBe('Request failed with status code 400')
  })

  it('cae al message genérico de axios si no hay body en absoluto (network error)', () => {
    const err = new AxiosError('Network Error')
    expect(extractErrorMessage(err)).toBe('Network Error')
  })

  it('usa .message para un Error plano', () => {
    expect(extractErrorMessage(new Error('algo salió mal'))).toBe('algo salió mal')
  })

  it('hace String() de cualquier otra cosa', () => {
    expect(extractErrorMessage('raw string')).toBe('raw string')
    expect(extractErrorMessage(42)).toBe('42')
  })
})
