import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiError } from '../shared/types.ts';

/** 全レスポンス共通のセキュリティヘッダ */
const commonHeaders: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex',
};

export const applyCommonHeaders = (res: ServerResponse): void => {
  for (const [k, v] of Object.entries(commonHeaders)) res.setHeader(k, v);
};

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
  });
  res.end(payload);
};

export const sendError = (res: ServerResponse, status: number, message: string): void => {
  const body: ApiError = { error: message };
  sendJson(res, status, body);
};

export const sendText = (res: ServerResponse, status: number, text: string): void => {
  const payload = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
  });
  res.end(payload);
};

export const sendMethodNotAllowed = (res: ServerResponse, allow = 'GET, HEAD'): void => {
  res.setHeader('Allow', allow);
  sendError(res, 405, 'method not allowed');
};

export const isReadMethod = (req: IncomingMessage): boolean =>
  req.method === 'GET' || req.method === 'HEAD';

export const MAX_BODY_BYTES = 16 * 1024;

/**
 * 状態を変える POST の共通チェック (CSRF 対策) → JSON ボディを unknown として返す。
 * 403: X-Requested-With: fetch が無い / 415: Content-Type が JSON でない / 413: 16KB 超 / 400: JSON 不正
 */
export const readJsonBody = async (req: IncomingMessage, res: ServerResponse): Promise<unknown> => {
  if (req.headers['x-requested-with'] !== 'fetch') throw new HttpError(403, 'X-Requested-With: fetch header required');
  const mediaType = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') throw new HttpError(415, 'Content-Type must be application/json');
  const declared = Number(req.headers['content-length'] ?? '0');
  const tooLarge = (): HttpError => {
    // 読み切らずに応答するので、応答後に接続を閉じる
    res.setHeader('Connection', 'close');
    return new HttpError(413, `request body too large (max ${MAX_BODY_BYTES} bytes)`);
  };
  if (declared > MAX_BODY_BYTES) throw tooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw tooLarge();
    chunks.push(buf);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (e) {
    throw new HttpError(400, `invalid JSON body: ${e instanceof Error ? e.message : String(e)}`);
  }
};
