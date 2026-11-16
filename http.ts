// Small HTTP helpers shared by the surfaces: JSON answers with the request-id header every
// REST reply must carry, request body reading, and JSON body parsing that never throws.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './store.ts';

export const JSON_TYPE = 'application/json; charset=utf-8';

/** Answer with a JSON body. Every reply carries a non-empty X-GitHub-Request-Id. */
export function sendJson(store: Store, res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  sendJsonBuffer(store, res, status, Buffer.from(`${JSON.stringify(body)}\n`, 'utf8'), headers);
}

/**
 * Answer with a JSON body that is already serialized, byte for byte what sendJson would
 * have produced for the same value. Hot read paths memoize these buffers and hand them
 * back here, so a repeat answer skips the object building and the stringify entirely;
 * the request id is still minted fresh for every reply.
 */
export function sendJsonBuffer(store: Store, res: ServerResponse, status: number, body: Buffer, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': body.length,
    'x-github-request-id': store.requestId(),
    ...headers,
  });
  res.end(body);
}

/** Answer with no body at all (a 204). */
export function sendEmpty(store: Store, res: ServerResponse, status: number): void {
  res.writeHead(status, { 'x-github-request-id': store.requestId() });
  res.end();
}

/** GitHub's error shape: a JSON object with a non-empty string message. */
export function sendError(store: Store, res: ServerResponse, status: number, message: string): void {
  sendJson(store, res, status, { message });
}

/** Read a whole request body (capped, so a hostile body cannot exhaust the 1 GiB sandbox). */
export function readBody(req: IncomingMessage, cap = 128 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > cap) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a request body as JSON; `{ ok: false }` for anything malformed, never a throw. */
export async function readJson(req: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const body = await readBody(req);
  if (body.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) as unknown };
  } catch {
    return { ok: false };
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function stringField(value: Record<string, unknown>, name: string): string | undefined {
  const field = value[name];
  return typeof field === 'string' ? field : undefined;
}
