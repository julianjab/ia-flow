import { open } from 'node:fs/promises'
import { TranscriptAssembler, type TranscriptMessage } from './TranscriptAssembler.js'

const CHUNK_BYTES = 1024 * 1024
const NEWLINE = 0x0a

export interface TranscriptTailOptions {
  /** Cada mensaje del assistant, apenas se completa. No debería tirar (si tira, se ignora). */
  onMessage: (message: TranscriptMessage) => void
  /** Lo anterior a este momento no se emite: una sesión retomada trae su historia. */
  since?: Date
}

/**
 * Sigue la transcripción de una sesión del CLI mientras corre: cada hook trae su `transcript_path`
 * y `read` lee SÓLO lo que se escribió desde la última vez (recuerda el offset en bytes y guarda
 * una última línea a medio escribir para la próxima), así el uso de cada request sale a medida
 * que pasa, no acumulado al final. Las lecturas se encolan: hooks en paralelo no leen dos veces
 * lo mismo. Best-effort: una transcripción que falta o no se puede leer nunca rompe la corrida.
 */
export class TranscriptTail {
  private path: string | undefined
  private offset = 0
  private rest: Buffer = Buffer.alloc(0)
  private assembler: TranscriptAssembler
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly options: TranscriptTailOptions) {
    this.assembler = new TranscriptAssembler(options.since)
  }

  /** Lee lo nuevo de `path`; con `flush`, además cierra el último mensaje (el modelo terminó). */
  read(path: string, options: { flush?: boolean } = {}): Promise<void> {
    return this.enqueue(async () => {
      await this.readNew(path)
      if (options.flush) this.emit(this.assembler.flush())
    })
  }

  /** Fin de la corrida: espera las lecturas en curso y cierra lo que quedó abierto. */
  finish(): Promise<void> {
    return this.enqueue(async () => this.emit(this.assembler.flush()))
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(work).catch(() => {})
    return this.queue
  }

  private async readNew(path: string): Promise<void> {
    if (path !== this.path) {
      // Otra transcripción (la sesión cambió de archivo): lo que quedó de la anterior terminó.
      if (this.path !== undefined) this.emit(this.assembler.flush())
      this.path = path
      this.offset = 0
      this.rest = Buffer.alloc(0)
    }
    let handle: Awaited<ReturnType<typeof open>>
    try {
      handle = await open(path, 'r')
    } catch {
      return
    }
    try {
      const { size } = await handle.stat()
      if (size < this.offset) {
        // Se truncó o se reemplazó: se relee desde el principio (lo ya emitido no se repite).
        this.offset = 0
        this.rest = Buffer.alloc(0)
      }
      while (this.offset < size) {
        const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, size - this.offset))
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, this.offset)
        if (bytesRead === 0) break
        this.offset += bytesRead
        this.consume(buffer.subarray(0, bytesRead))
      }
    } finally {
      await handle.close().catch(() => {})
    }
  }

  /** Procesa las líneas completas; lo que viene después del último salto espera al resto. */
  private consume(chunk: Buffer): void {
    const data = this.rest.length > 0 ? Buffer.concat([this.rest, chunk]) : chunk
    const end = data.lastIndexOf(NEWLINE)
    if (end < 0) {
      this.rest = Buffer.from(data)
      return
    }
    this.rest = Buffer.from(data.subarray(end + 1))
    for (const line of data.subarray(0, end).toString('utf-8').split('\n')) {
      this.emit(this.assembler.push(line))
    }
  }

  private emit(messages: TranscriptMessage[]): void {
    for (const message of messages) {
      try {
        this.options.onMessage(message)
      } catch {
        // Quien observa no puede cortar la lectura.
      }
    }
  }
}
