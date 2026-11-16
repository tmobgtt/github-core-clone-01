// A small HTTP/1.1 transport on raw sockets, shaped exactly like the slice of
// node:http the forge's surfaces program against: a request is an event emitter
// with method, url and headers whose body replays from memory, and a response is
// writeHead plus end. node:http spends most of a request's life in machinery this
// forge never uses (stream plumbing, header objects, a general parser bridged
// through WASM); on the trial's shared vCPUs that machinery is the largest single
// cost of every surface, so the forge speaks the wire itself.
//
// The ingest is synchronous in shape: a request's body is framed and buffered in
// full (content-length or chunked, capped like readBody's cap) before the handler
// runs, and the handler's reader replays it. One request per connection is in
// flight at a time, in arrival order, which is the order every client of the
// suite already observes.

import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import { STATUS_CODES } from 'node:http';

/** The largest header block (request line plus headers) one request may carry. */
const HEADER_CAP = 64 * 1024;
/** The largest request body, mirroring readBody's cap in http.ts. */
const BODY_CAP = 128 * 1024 * 1024;

export class ForgeRequest extends EventEmitter {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly httpVersion: string;
  private chunks: Buffer[];
  private fed = false;
  private gone: (() => void) | null;

  constructor(method: string, url: string, headers: Record<string, string>, httpVersion: string, chunks: Buffer[], gone: () => void) {
    super();
    this.method = method;
    this.url = url;
    this.headers = headers;
    this.httpVersion = httpVersion;
    this.chunks = chunks;
    this.gone = gone;
    // The body replays when the first data listener lands, never before: a reader
    // subscribes to data, end and error in one breath, and a replay that started
    // during the first subscription would fire end before it was heard. Deferring
    // to a microtask lets the whole subscription land first, whenever it happens.
    this.on('newListener', (event: string | symbol) => {
      if (event === 'data') this.startFeed();
    });
  }

  private startFeed(): void {
    if (this.fed) return;
    this.fed = true;
    const chunks = this.chunks;
    this.chunks = [];
    queueMicrotask(() => {
      for (const chunk of chunks) this.emit('data', chunk);
      this.emit('end');
    });
  }

  /** readBody's escape hatch for an oversize body: drop the whole connection. */
  destroy(): void {
    const gone = this.gone;
    this.gone = null;
    if (gone !== null) gone();
  }
}

export class ForgeResponse {
  headersSent = false;
  private status = 200;
  private headers: Record<string, string> = {};
  private sent = false;
  private readonly method: string;
  private readonly finish: (head: Buffer, body: Buffer | null) => void;

  constructor(method: string, finish: (head: Buffer, body: Buffer | null) => void) {
    this.method = method;
    this.finish = finish;
  }

  writeHead(status: number, headers: Record<string, string> = {}): this {
    if (this.sent) return this;
    this.status = status;
    this.headers = headers;
    this.headersSent = true;
    return this;
  }

  end(data?: string | Buffer): void {
    if (this.sent) return;
    this.sent = true;
    this.headersSent = true;
    const body = data === undefined ? Buffer.alloc(0) : typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const bodiless = this.status === 204 || this.status === 304 || this.method === 'HEAD';
    const lines = [`HTTP/1.1 ${this.status} ${STATUS_CODES[this.status] ?? ''}\r\n`];
    let hasLength = false;
    for (const [name, value] of Object.entries(this.headers)) {
      if (name.toLowerCase() === 'content-length') hasLength = true;
      lines.push(`${name}: ${value}\r\n`);
    }
    // Every answer this forge gives is one buffered shot, so a missing length can
    // always be supplied exactly; a bodiless answer needs none.
    if (!hasLength && !bodiless) lines.push(`content-length: ${body.length}\r\n`);
    lines.push('\r\n');
    this.finish(Buffer.from(lines.join(''), 'latin1'), bodiless ? null : body);
  }
}

/** The handler the surfaces hang off, the shape createServer's callback had. */
export type ForgeHandler = (req: ForgeRequest, res: ForgeResponse) => void;

/** One connection's parse state: a byte buffer and the stage it is in. */
class Connection {
  private buffer: Buffer = Buffer.alloc(0);
  private busy = false;
  private closed = false;
  private expectSent = false;
  private readonly socket: Socket;
  private readonly handler: ForgeHandler;

  constructor(socket: Socket, handler: ForgeHandler) {
    this.socket = socket;
    this.handler = handler;
    socket.setNoDelay(true);
    socket.on('data', (chunk: Buffer) => {
      this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
      this.pump();
    });
    socket.on('error', () => this.close());
    socket.on('close', () => {
      this.closed = true;
    });
  }

  get idle(): boolean {
    return !this.busy && this.buffer.length === 0;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
  }

  /** Parse and dispatch while there is a whole request buffered and none in flight. */
  private pump(): void {
    if (this.busy || this.closed) return;
    const parsed = this.parseHead();
    if (parsed === null) return;
    if (parsed.error !== undefined) {
      this.closed = true;
      this.socket.end(`HTTP/1.1 400 ${STATUS_CODES[400] ?? ''}\r\ncontent-length: 0\r\n\r\n`);
      return;
    }
    // A client waiting on 100-continue sends its body only once it is answered,
    // and the peek above may run again for this same head, so answer at most once.
    if (parsed.expectContinue && !this.expectSent) {
      this.expectSent = true;
      this.socket.write('HTTP/1.1 100 Continue\r\n\r\n');
    }
    const taken = this.takeBody(parsed);
    if (taken === null) return; // The body is still arriving; the next data event resumes.
    this.buffer = this.buffer.subarray(parsed.headBytes + taken.consumed);
    this.expectSent = false;
    this.busy = true;
    const keepAlive = parsed.keepAlive;
    const body = taken.chunks;
    const req = new ForgeRequest(parsed.method, parsed.target, parsed.headers, parsed.version, body, () => this.close());
    const res = new ForgeResponse(parsed.method, (head, payload) => {
      const bytes = payload === null ? head : Buffer.concat([head, payload]);
      if (this.closed) return;
      if (!keepAlive) {
        this.closed = true;
        this.socket.end(bytes);
        return;
      }
      this.socket.write(bytes);
      this.busy = false;
      this.pump();
    });
    this.handler(req, res);
  }

  /**
   * Peek at one request head (request line and headers) without consuming it, or
   * null when it has not fully arrived. A head that can never be valid answers
   * `error`. The head is consumed only once its body is complete too, so this
   * peek may run several times for one request as its bytes arrive.
   */
  private parseHead(): {
    method: string;
    target: string;
    version: string;
    headers: Record<string, string>;
    keepAlive: boolean;
    expectContinue: boolean;
    headBytes: number;
    framing: { kind: 'length'; length: number } | { kind: 'chunked' } | { kind: 'none' };
    error?: string;
  } | null {
    const end = this.buffer.indexOf('\r\n\r\n');
    if (end === -1) {
      if (this.buffer.length > HEADER_CAP) return { error: 'headers too large' } as never;
      return null;
    }
    // Scan line by line in place: one latin1 pass over the head, no line array.
    const text = this.buffer.toString('latin1', 0, end);
    const firstBreak = text.indexOf('\r\n');
    const requestLine = firstBreak === -1 ? text : text.slice(0, firstBreak);
    const firstSpace = requestLine.indexOf(' ');
    const lastSpace = requestLine.lastIndexOf(' ');
    if (firstSpace <= 0 || lastSpace <= firstSpace) return { error: 'bad request line' } as never;
    const method = requestLine.slice(0, firstSpace);
    const target = requestLine.slice(firstSpace + 1, lastSpace);
    const version = requestLine.slice(lastSpace + 1);
    if (!version.startsWith('HTTP/1.')) return { error: 'bad version' } as never;
    const headers: Record<string, string> = {};
    let at = firstBreak + 2;
    while (at < text.length) {
      const lineEnd = text.indexOf('\r\n', at);
      const line = lineEnd === -1 ? text.slice(at) : text.slice(at, lineEnd);
      const colon = line.indexOf(':');
      if (colon <= 0) return { error: 'bad header' } as never;
      const name = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      const held = headers[name];
      headers[name] = held === undefined ? value : `${held}, ${value}`;
      if (lineEnd === -1) break;
      at = lineEnd + 2;
    }
    const connection = (headers['connection'] ?? '').toLowerCase();
    const keepAlive = version === 'HTTP/1.0' ? connection === 'keep-alive' : connection !== 'close';
    const encoding = (headers['transfer-encoding'] ?? '').toLowerCase();
    let framing: { kind: 'length'; length: number } | { kind: 'chunked' } | { kind: 'none' } = { kind: 'none' };
    if (encoding.includes('chunked')) {
      framing = { kind: 'chunked' };
    } else if (headers['content-length'] !== undefined) {
      const length = Number.parseInt(headers['content-length'] as string, 10);
      if (!Number.isSafeInteger(length) || length < 0) return { error: 'bad content-length' } as never;
      framing = { kind: 'length', length };
    }
    const expectContinue = (headers['expect'] ?? '').toLowerCase().includes('100-continue');
    return { method, target, version, headers, keepAlive, expectContinue, headBytes: end + 4, framing };
  }

  /**
   * Measure the framed body starting at `headBytes` once it has fully arrived,
   * returning its chunks (views into the buffer) and its total wire size. Null
   * while bytes are still missing; an oversize or malformed body closes the
   * connection, readBody's cap enforced at the wire.
   */
  private takeBody(parsed: {
    headBytes: number;
    framing: { kind: 'length'; length: number } | { kind: 'chunked' } | { kind: 'none' };
  }): { chunks: Buffer[]; consumed: number } | null {
    const framing = parsed.framing;
    const start = parsed.headBytes;
    if (framing.kind === 'none') return { chunks: [], consumed: 0 };
    if (framing.kind === 'length') {
      if (framing.length > BODY_CAP) {
        this.close();
        return null;
      }
      if (this.buffer.length < start + framing.length) return null;
      return { chunks: [this.buffer.subarray(start, start + framing.length)], consumed: framing.length };
    }
    // Chunked: walk the chunks without copying until the terminal chunk and its
    // trailer are all present.
    const chunks: Buffer[] = [];
    let total = 0;
    let at = start;
    for (;;) {
      const lineEnd = this.buffer.indexOf('\r\n', at);
      if (lineEnd === -1) return null;
      const sizeText = this.buffer.toString('latin1', at, lineEnd).split(';', 1)[0] as string;
      const size = Number.parseInt(sizeText, 16);
      if (Number.isNaN(size) || size < 0) {
        this.close();
        return null;
      }
      if (size === 0) {
        // After the terminal chunk: an optional trailer of header lines and a
        // closing empty line, or the empty line alone.
        const rest = this.buffer.subarray(lineEnd + 2);
        if (rest.length >= 2 && rest[0] === 13 && rest[1] === 10) {
          return { chunks, consumed: lineEnd + 2 + 2 - start };
        }
        const trailerClose = rest.indexOf('\r\n\r\n');
        if (trailerClose === -1) return null;
        return { chunks, consumed: lineEnd + 2 + trailerClose + 4 - start };
      }
      total += size;
      if (total > BODY_CAP) {
        this.close();
        return null;
      }
      const dataStart = lineEnd + 2;
      const dataEnd = dataStart + size;
      if (this.buffer.length < dataEnd + 2) return null;
      chunks.push(this.buffer.subarray(dataStart, dataEnd));
      at = dataEnd + 2;
    }
  }
}

/** The server object main.ts drives: listen, address, close, closeIdleConnections. */
export class ForgeServer extends EventEmitter {
  private readonly inner: NetServer;
  private readonly connections = new Set<Connection>();

  constructor(handler: ForgeHandler) {
    super();
    this.inner = createNetServer((socket) => {
      const connection = new Connection(socket, handler);
      this.connections.add(connection);
      socket.on('close', () => this.connections.delete(connection));
    });
    this.inner.on('error', (err) => this.emit('error', err));
  }

  listen(port: number, callback?: () => void): this {
    this.inner.listen(port, callback);
    return this;
  }

  address(): { port: number } | null {
    const address = this.inner.address();
    if (address === null || typeof address === 'string') return null;
    return { port: address.port };
  }

  close(callback?: () => void): this {
    this.inner.close(callback);
    return this;
  }

  closeIdleConnections(): void {
    for (const connection of this.connections) {
      if (connection.idle) connection.close();
    }
  }
}

/** Build the transport server around the forge's request handler. */
export function createForgeServer(handler: ForgeHandler): ForgeServer {
  return new ForgeServer(handler);
}
