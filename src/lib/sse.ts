const encoder = new TextEncoder()

export type SseSink = {
  send(data: unknown, event?: string, id?: string): void
  comment(text: string): void
  close(): void
  readonly closed: boolean
}

/**
 * Builds a text/event-stream response. `setup` receives a sink and returns a cleanup callback
 * that runs once when the client disconnects or the stream is closed by the server.
 */
export function sseResponse(
  request: Request,
  setup: (sink: SseSink) => void | (() => void) | Promise<void | (() => void)>,
  options: { keepAliveMs?: number; headers?: Record<string, string> } = {}
) {
  let cleanup: (() => void) | void
  let keepAlive: ReturnType<typeof setInterval> | undefined
  let closed = false
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined

  const finish = () => {
    if (closed) return
    closed = true
    if (keepAlive) clearInterval(keepAlive)
    request.signal.removeEventListener('abort', finish)
    try {
      cleanup?.()
    } catch {}
    try {
      controllerRef?.close()
    } catch {}
  }

  const sink: SseSink = {
    send(data, event, id) {
      if (closed || !controllerRef) return
      let chunk = ''
      if (id) chunk += `id: ${id}\n`
      if (event) chunk += `event: ${event}\n`
      chunk += `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`
      try {
        controllerRef.enqueue(encoder.encode(chunk))
      } catch {
        finish()
      }
    },
    comment(text) {
      if (closed || !controllerRef) return
      try {
        controllerRef.enqueue(encoder.encode(`: ${text}\n\n`))
      } catch {
        finish()
      }
    },
    close: finish,
    get closed() {
      return closed
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controllerRef = controller
      request.signal.addEventListener('abort', finish)
      keepAlive = setInterval(() => sink.comment('ping'), options.keepAliveMs ?? 15_000)
      try {
        cleanup = await setup(sink)
      } catch (error) {
        finish()
        throw error
      }
      if (closed) cleanup?.()
    },
    cancel: finish
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      ...options.headers
    }
  })
}
