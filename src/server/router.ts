import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { isAccountId } from '../db/paths.ts';
import { HttpError, isReadMethod, readJsonBody, sendError, sendJson, sendMethodNotAllowed, sendText } from './http.ts';
import type { SettingsRequest } from '../shared/types.ts';
import type { Admin } from './admin.ts';
import { locateFile, resolveUnder, sendFile, type Located } from './files.ts';
import { parseKeysetCursor, parseLimit, parseOrdCursor, parseTerms, parseTweetFilter, parseYear } from './params.ts';
import type { Registry } from './registry.ts';
import type { SettingsStore } from './settings.ts';

export type Deps = {
  readonly registry: Registry;
  readonly settings: SettingsStore;
  readonly admin: Admin;
  readonly mediaRoot: string;
  readonly webRoot: string;
};

const MEDIA_CACHE = 'public, max-age=31536000, immutable';
// 更新後に古い JS/CSS が残らないよう毎回再検証する (未変更なら 304)
const STATIC_CACHE = 'no-cache';
const INDEX_CACHE = 'no-cache';
const ID_RE = /^[0-9A-Za-z_-]{1,64}$/;

const decodePath = (raw: string): string => {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, 'invalid path encoding');
  }
};

const POST_ROUTES: ReadonlySet<string> = new Set(['/api/admin/import', '/api/admin/reset', '/api/admin/settings']);

const parseSettingsRequest = (body: unknown): SettingsRequest => {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, 'request body must be a JSON object');
  const tz = (body as Record<string, unknown>)['timezone'];
  if (tz !== null && typeof tz !== 'string') throw new HttpError(400, 'timezone must be a string or null');
  return { timezone: tz };
};

const handlePost = async (deps: Deps, pathname: string, req: IncomingMessage, res: ServerResponse): Promise<void> => {
  const body = await readJsonBody(req, res);
  if (pathname === '/api/admin/import') return sendJson(res, 202, deps.admin.startImport(body));
  if (pathname === '/api/admin/settings') return sendJson(res, 200, deps.settings.set(parseSettingsRequest(body).timezone));
  deps.admin.reset(body);
  res.writeHead(204, { 'Cache-Control': 'no-store' });
  res.end();
};

const handleApi = async (deps: Deps, pathname: string, sp: URLSearchParams, res: ServerResponse): Promise<void> => {
  if (pathname === '/api/admin/archives') return sendJson(res, 200, await deps.admin.archives());
  if (pathname === '/api/admin/import/status') return sendJson(res, 200, deps.admin.status());
  if (pathname === '/api/accounts') return sendJson(res, 200, deps.registry.list());
  if (pathname === '/api/settings') return sendJson(res, 200, deps.settings.get());
  // ここから先はアカウント単位 (?account= 省略時は既定アカウント)
  const q = deps.registry.resolve(sp.get('account')).queries;
  if (pathname === '/api/admin/imports') return sendJson(res, 200, q.imports());
  if (pathname === '/api/meta') return sendJson(res, 200, q.meta());
  if (pathname === '/api/stats') return sendJson(res, 200, q.stats());
  if (pathname === '/api/stats/daily') return sendJson(res, 200, q.dailyCounts(parseYear(sp.get('year'))));
  if (pathname === '/api/tweets') return sendJson(res, 200, q.tweets(parseTweetFilter(sp, deps.settings.timeZone())));
  if (pathname === '/api/calendar') return sendJson(res, 200, q.calendar());
  if (pathname === '/api/dm') return sendJson(res, 200, q.dmConversations());
  if (pathname === '/api/likes') {
    const page = q.likes(parseTerms(sp.get('q')), parseOrdCursor(sp.get('cursor')), parseLimit(sp.get('limit')));
    return sendJson(res, 200, page);
  }
  const tweet = /^\/api\/tweets\/([^/]+)$/.exec(pathname);
  if (tweet !== null) {
    const id = decodePath(tweet[1] ?? '');
    const detail = ID_RE.test(id) ? q.tweetDetail(id) : null;
    return detail === null ? sendError(res, 404, 'tweet not found') : sendJson(res, 200, detail);
  }
  const dm = /^\/api\/dm\/([^/]+)$/.exec(pathname);
  if (dm !== null) {
    const id = decodePath(dm[1] ?? '');
    const page = q.dmMessages(id, parseKeysetCursor(sp.get('cursor')), parseLimit(sp.get('limit')));
    return page === null ? sendError(res, 404, 'conversation not found') : sendJson(res, 200, page);
  }
  return sendError(res, 404, 'not found');
};

const serveMedia = async (deps: Deps, pathname: string, req: IncomingMessage, res: ServerResponse): Promise<void> => {
  const rel = decodePath(pathname.slice('/media/'.length));
  // 先頭セグメントはアカウント ID (`/media/<accountId>/data/...`)
  if (!isAccountId(rel.split('/')[0] ?? '')) return sendError(res, 400, 'invalid media path');
  const candidate = resolveUnder(deps.mediaRoot, rel);
  if (candidate === null || rel === '') return sendError(res, 400, 'invalid media path');
  const file = await locateFile(deps.mediaRoot, candidate);
  if (file === null) return sendError(res, 404, 'media not found');
  sendFile(req, res, file, MEDIA_CACHE);
};

const serveStatic = async (deps: Deps, pathname: string, req: IncomingMessage, res: ServerResponse): Promise<void> => {
  const rel = decodePath(pathname).replace(/^\/+/, '');
  const candidate = resolveUnder(deps.webRoot, rel);
  if (candidate === null) return sendError(res, 400, 'invalid path');
  const found: Located | null = rel === '' ? null : await locateFile(deps.webRoot, candidate);
  if (found !== null) {
    const isIndex = found.path.endsWith('/index.html');
    return sendFile(req, res, found, isIndex ? INDEX_CACHE : STATIC_CACHE);
  }
  // SPA フォールバック
  const index = await locateFile(deps.webRoot, join(deps.webRoot, 'index.html'));
  if (index === null) return sendError(res, 404, 'ui not built (index.html missing)');
  sendFile(req, res, index, INDEX_CACHE);
};

const route = async (deps: Deps, req: IncomingMessage, res: ServerResponse): Promise<void> => {
  // URL パーサが `..` を正規化する前の生パスでトラバーサルを弾く
  const rawPath = (req.url ?? '/').split('?')[0] ?? '/';
  if (rawPath.split('/').some((seg) => decodePath(seg) === '..')) throw new HttpError(400, 'invalid path');
  const url = new URL(req.url ?? '/', 'http://localhost');
  const { pathname } = url;
  if (req.method === 'POST' && POST_ROUTES.has(pathname)) return handlePost(deps, pathname, req, res);
  if (!isReadMethod(req)) return sendMethodNotAllowed(res, POST_ROUTES.has(pathname) ? 'POST' : 'GET, HEAD');
  if (pathname === '/healthz') return sendText(res, 200, 'ok');
  if (pathname === '/api' || pathname.startsWith('/api/')) return handleApi(deps, pathname, url.searchParams, res);
  if (pathname.startsWith('/media/')) return serveMedia(deps, pathname, req, res);
  return serveStatic(deps, pathname, req, res);
};

/** 例外は 400/404 等の HttpError か 500 に変換する (ログ付き) */
export const createHandler =
  (deps: Deps) =>
  async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      await route(deps, req, res);
    } catch (e) {
      if (e instanceof HttpError) {
        if (!res.headersSent) sendError(res, e.status, e.message);
        return;
      }
      const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
      console.error(`[error] ${req.method} ${req.url}: ${msg}`);
      if (!res.headersSent) sendError(res, 500, 'internal server error');
      else res.destroy();
    }
  };
