import { createHash, timingSafeEqual } from 'node:crypto'
import type {
  AnthropicDeltaHandler,
  AnthropicMessagesResponse,
} from '@ia-flow/provider-anthropic-api'
import {
  type CompletionMeta,
  contentChunk,
  finalChunk,
  finishReason,
  roleChunk,
  toChatCompletion,
  toErrorResponse,
  toolCallsChunk,
  toolCallsOfBlocks,
  usageChunk,
  usageOf,
} from './anthropicToOpenai.js'
import type { GatewayConfig } from './config.js'
import { BadRequestError, toAnthropicRequest } from './openaiToAnthropic.js'
import type { ChatCompletionRequest } from './openaiTypes.js'

/** El puerto hacia Anthropic: lo que el gateway necesita de `AnthropicClient`, nada más. */
export type SendToAnthropic = (
  body: Record<string, unknown>,
  options: { stream: boolean; onDelta?: AnthropicDeltaHandler },
) => Promise<AnthropicMessagesResponse>

/** El logger que el handler necesita: sin contenido de mensajes, sólo metadatos de la llamada. */
export interface GatewayLog {
  info(message: string, attributes?: Record<string, string | number | boolean>): void
  warn(message: string, attributes?: Record<string, string | number | boolean>): void
  error(message: string, attributes?: Record<string, string | number | boolean>): void
}

const NOOP_LOG: GatewayLog = { info() {}, warn() {}, error() {} }

export interface GatewayDeps {
  config: Pick<GatewayConfig, 'token' | 'models' | 'defaultModel' | 'defaultMaxTokens'> &
    Partial<Pick<GatewayConfig, 'systemPrompt'>>
  send: SendToAnthropic
  log?: GatewayLog
  now?: () => number
  newId?: () => string
}

const JSON_HEADERS = { 'content-type': 'application/json' }
const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })

/** Compara hasheando antes: `timingSafeEqual` exige el mismo largo, y así no se filtra el del token. */
function tokenMatches(received: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest()
  return timingSafeEqual(digest(received), digest(expected))
}

function isAuthorized(request: Request, token: string): boolean {
  const header = request.headers.get('authorization') ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(header)
  return match?.[1] !== undefined && tokenMatches(match[1].trim(), token)
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))

async function readChatRequest(request: Request): Promise<ChatCompletionRequest> {
  try {
    return (await request.json()) as ChatCompletionRequest
  } catch {
    throw new BadRequestError('el body no es JSON válido')
  }
}

/** El handler HTTP del gateway: `(Request) → Response`, sin servidor ni red propios — quien lo
 *  monta (`main.ts`) le pasa la config y el puerto hacia Anthropic. */
export function createHandler(deps: GatewayDeps): (request: Request) => Promise<Response> {
  const { config, send } = deps
  const log = deps.log ?? NOOP_LOG
  const now = deps.now ?? (() => Date.now())
  const newId = deps.newId ?? (() => crypto.randomUUID().replaceAll('-', ''))

  const listModels = () =>
    json({
      object: 'list',
      data: config.models.map((id) => ({
        id,
        object: 'model',
        created: 0,
        owned_by: 'anthropic',
      })),
    })

  const complete = async (chat: ChatCompletionRequest): Promise<Response> => {
    const body = toAnthropicRequest(chat, {
      model: config.defaultModel,
      maxTokens: config.defaultMaxTokens,
      systemPrompt: config.systemPrompt,
    })
    const meta: CompletionMeta = {
      id: `chatcmpl-${newId()}`,
      model: String(body.model),
      created: Math.floor(now() / 1000),
    }
    const startedAt = now()
    const tools = Array.isArray(body.tools) ? body.tools.length : 0
    log.info(
      `${meta.id} → ${meta.model} (${chat.stream ? 'stream' : 'sin stream'}, ${chat.messages?.length ?? 0} mensajes, ${tools} tools)`,
    )
    if (chat.stream) return stream(body, meta, chat.stream_options?.include_usage === true)
    const response = await send(body, { stream: false })
    logDone(meta, response, startedAt)
    return json(toChatCompletion(response, meta))
  }

  const logDone = (
    meta: CompletionMeta,
    response: AnthropicMessagesResponse,
    startedAt: number,
  ) => {
    const usage = usageOf(response)
    log.info(
      `${meta.id} listo: ${response.stop_reason ?? 'sin stop_reason'}, ${usage.prompt_tokens}+${usage.completion_tokens} tokens (${now() - startedAt}ms)`,
    )
  }

  const stream = (
    body: Record<string, unknown>,
    meta: CompletionMeta,
    includeUsage: boolean,
  ): Response => {
    const encoder = new TextEncoder()
    const startedAt = now()
    const readable = new ReadableStream<Uint8Array>({
      async start(controller) {
        const write = (payload: unknown) =>
          controller.enqueue(
            encoder.encode(
              `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`,
            ),
          )
        write(roleChunk(meta))
        try {
          const response = await send(body, {
            stream: true,
            onDelta: (delta) => {
              if (delta.type === 'text' && delta.delta) write(contentChunk(meta, delta.delta))
            },
          })
          logDone(meta, response, startedAt)
          const calls = toolCallsOfBlocks(response.content)
          if (calls.length > 0) write(toolCallsChunk(meta, calls))
          write(finalChunk(meta, finishReason(response.stop_reason)))
          if (includeUsage) write(usageChunk(meta, usageOf(response)))
        } catch (err) {
          const { status, body: errorBody } = toErrorResponse(err)
          log.error(`${meta.id} falló en el stream (${status}): ${errorMessage(err)}`)
          write(errorBody)
        }
        write('[DONE]')
        controller.close()
      },
    })
    return new Response(readable, { headers: SSE_HEADERS })
  }

  const failure = (err: unknown, route: string): Response => {
    const { status, body } = toErrorResponse(err)
    const text = `${route} falló (${status}): ${errorMessage(err)}`
    if (status >= 500) log.error(text)
    else log.warn(text)
    return json(body, status)
  }

  return async (request) => {
    const { pathname } = new URL(request.url)
    if (pathname === '/health') return json({ status: 'ok' })
    if (!isAuthorized(request, config.token)) {
      log.warn(`token inválido en ${request.method} ${pathname}`)
      return json(
        { error: { message: 'token inválido', type: 'authentication_error', code: null } },
        401,
      )
    }
    try {
      if (request.method === 'GET' && pathname === '/v1/models') return listModels()
      if (request.method === 'POST' && pathname === '/v1/chat/completions') {
        return await complete(await readChatRequest(request))
      }
      return json(
        {
          error: {
            message: `no existe ${request.method} ${pathname}`,
            type: 'not_found',
            code: null,
          },
        },
        404,
      )
    } catch (err) {
      return failure(err, `${request.method} ${pathname}`)
    }
  }
}
