import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { SchemaTool } from '../SchemaTool.js'

const EchoInput = z.strictObject({
  text: z.string().describe('Texto a repetir'),
  times: z.number().int().positive().optional(),
})

class EchoTool extends SchemaTool<typeof EchoInput> {
  readonly name = 'echo'
  readonly description = 'repite texto'
  readonly input = EchoInput
  calls = 0

  protected execute(input: z.infer<typeof EchoInput>): string {
    this.calls++
    return input.text.repeat(input.times ?? 1)
  }
}

describe('SchemaTool', () => {
  it('derives inputSchema from the zod schema, without $schema', () => {
    const tool = new EchoTool()

    expect(tool.inputSchema).toEqual({
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Texto a repetir' },
        times: { type: 'integer', exclusiveMinimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      },
      required: ['text'],
      additionalProperties: false,
    })
  })

  it('memoizes inputSchema', () => {
    const tool = new EchoTool()

    expect(tool.inputSchema).toBe(tool.inputSchema)
  })

  it('runs execute with the parsed input when valid', async () => {
    const tool = new EchoTool()

    expect(await tool.handler({ text: 'ab', times: 2 })).toBe('abab')
  })

  it('rejects with a readable error and skips execute when a required field is missing', async () => {
    const tool = new EchoTool()

    await expect(tool.handler({})).rejects.toThrow(/echo: input inválido[\s\S]*→ at text/)
    expect(tool.calls).toBe(0)
  })

  it('rejects keys the schema does not declare', async () => {
    const tool = new EchoTool()

    await expect(tool.handler({ text: 'a', extra: 1 })).rejects.toThrow(/Unrecognized key: "extra"/)
    expect(tool.calls).toBe(0)
  })

  it('rejects a non-object input', async () => {
    const tool = new EchoTool()

    await expect(tool.handler(undefined)).rejects.toThrow(/echo: input inválido/)
  })
})

const SubmitInput = z.strictObject({ result: z.strictObject({ text: z.string() }) })

class SubmitTool extends SchemaTool<typeof SubmitInput> {
  readonly name = 'submit_done'
  readonly description = 'entrega el resultado'
  readonly input = SubmitInput
  received: unknown[] = []

  protected execute(input: z.infer<typeof SubmitInput>): string {
    this.received.push(input)
    return 'ok'
  }
}

describe('SchemaTool — un objeto anidado que llegó como string', () => {
  it('runs execute with the repaired object instead of rejecting', async () => {
    const tool = new SubmitTool()

    await tool.handler({ result: '\n<parameter name="text">## lines 1-2\nfoo' })

    expect(tool.received).toEqual([{ result: { text: '## lines 1-2\nfoo' } }])
  })

  it('still rejects with the original error when the string is not the object', async () => {
    const tool = new SubmitTool()

    await expect(tool.handler({ result: 'sin forma' })).rejects.toThrow(
      /submit_done: input inválido[\s\S]*expected object, received string[\s\S]*→ at result/,
    )
    expect(tool.received).toEqual([])
  })
})
