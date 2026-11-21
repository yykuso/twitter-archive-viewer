import type {
  ArchiveFile,
  DmConversation,
  DmMessage,
  ImportJob,
  ImportRecord,
  ImportRequest,
  ImportStage,
  ImportStats,
  Like,
  Meta,
  MonthCount,
  Page,
  ResetRequest,
  TableStats,
  Tweet,
  TweetDetail,
  TweetQuery,
} from '../../src/shared/types.ts';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const isPageShape = (v: unknown): v is { items: unknown[]; nextCursor: string | null } =>
  isRecord(v) && Array.isArray(v['items']) && (v['nextCursor'] === null || typeof v['nextCursor'] === 'string');

const isTweetLike = (v: unknown): v is Tweet =>
  isRecord(v) && typeof v['id'] === 'string' && typeof v['createdAt'] === 'string' && typeof v['text'] === 'string' && Array.isArray(v['media']);

const isPageOf = <T>(item: (v: unknown) => v is T) => (v: unknown): v is Page<T> =>
  isPageShape(v) && v.items.every(item);

const isLike = (v: unknown): v is Like => isRecord(v) && typeof v['tweetId'] === 'string' && typeof v['text'] === 'string' && typeof v['url'] === 'string';
const isConv = (v: unknown): v is DmConversation => isRecord(v) && typeof v['id'] === 'string' && Array.isArray(v['participants']);
const isMsg = (v: unknown): v is DmMessage => isRecord(v) && typeof v['id'] === 'string' && typeof v['text'] === 'string' && Array.isArray(v['media']);
const isMonth = (v: unknown): v is MonthCount => isRecord(v) && typeof v['month'] === 'string' && typeof v['count'] === 'number';

const isMeta = (v: unknown): v is Meta =>
  isRecord(v) &&
  (v['account'] === null || (isRecord(v['account']) && typeof v['account']['username'] === 'string')) &&
  isRecord(v['counts']) &&
  typeof v['importCount'] === 'number';

const STAGES: readonly string[] = ['queued', 'reading', 'writing', 'swapping', 'media', 'done', 'failed'];
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isTableStats = (v: unknown): v is TableStats => isRecord(v) && isNum(v['added']) && isNum(v['updated']) && isNum(v['seen']);
const isImportStats = (v: unknown): v is ImportStats =>
  isRecord(v) && isTableStats(v['tweets']) && isTableStats(v['likes']) && isTableStats(v['dmMessages']) &&
  isRecord(v['removed']) && isNum(v['removed']['tweets']) && isNum(v['removed']['likes']) && isNum(v['removed']['dmMessages']) &&
  isNum(v['mediaFiles']);
const isImportRecord = (v: unknown): v is ImportRecord =>
  isRecord(v) && isNum(v['id']) && typeof v['fileName'] === 'string' && typeof v['generatedAt'] === 'string' &&
  typeof v['finishedAt'] === 'string' && isImportStats(v['stats']);
const isArchiveFile = (v: unknown): v is ArchiveFile =>
  isRecord(v) && typeof v['name'] === 'string' && isNum(v['size']) && typeof v['modifiedAt'] === 'string' &&
  (v['imported'] === null || isImportRecord(v['imported']));
const isImportJob = (v: unknown): v is ImportJob =>
  isRecord(v) && typeof v['id'] === 'string' && typeof v['fileName'] === 'string' &&
  typeof v['stage'] === 'string' && STAGES.includes(v['stage']) && typeof v['startedAt'] === 'string' &&
  (v['progress'] === null || (isRecord(v['progress']) && isNum(v['progress']['done']) && isNum(v['progress']['total']))) &&
  (v['stats'] === null || isImportStats(v['stats']));
export const isStage = (v: string): v is ImportStage => STAGES.includes(v);

const isTweetDetail = (v: unknown): v is TweetDetail =>
  isRecord(v) && isTweetLike(v['tweet']) && Array.isArray(v['replies']);

export class ApiFailure extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiFailure';
    this.status = status;
  }
}

const buildUrl = (path: string, params: Readonly<Record<string, string | undefined>>): string => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') sp.set(k, v);
  const qs = sp.toString();
  return qs ? `${path}?${qs}` : path;
};

const request = async (url: string, init: RequestInit): Promise<unknown> => {
  const method = init.method ?? 'GET';
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    console.error(`[api] network error: ${method} ${url}`, e);
    throw new ApiFailure('ネットワークエラーが発生しました', 0);
  }
  if (res.status === 204) return null;
  let body: unknown = null;
  try {
    body = await res.json();
  } catch (e) {
    console.error(`[api] invalid JSON: ${method} ${url} (HTTP ${res.status})`, e);
    throw new ApiFailure(`サーバーの応答が不正です (HTTP ${res.status})`, res.status);
  }
  if (!res.ok) {
    const msg = isRecord(body) && typeof body['error'] === 'string' ? body['error'] : `HTTP ${res.status}`;
    // 409 (実行中) は想定内の競合なので警告に留める。UI 側で表示する
    (res.status === 409 ? console.warn : console.error)(`[api] ${method} ${url} failed: ${msg}`);
    throw new ApiFailure(msg, res.status);
  }
  return body;
};

const getJson = (url: string): Promise<unknown> => request(url, { headers: { accept: 'application/json' } });

/** 全ての POST はこれを使う (CSRF 対策ヘッダー付き)。204 のとき null を返す */
export const postJson = (url: string, body: unknown): Promise<unknown> =>
  request(url, {
    method: 'POST',
    headers: { accept: 'application/json', 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
    body: JSON.stringify(body),
  });

const expect = <T>(url: string, body: unknown, guard: (v: unknown) => v is T, what: string): T => {
  if (!guard(body)) {
    console.error(`[api] unexpected shape for ${what}: ${url}`, body);
    throw new ApiFailure(`${what} の形式が想定と異なります`, 0);
  }
  return body;
};

export const fetchMeta = async (): Promise<Meta> => {
  const url = '/api/meta';
  return expect(url, await getJson(url), isMeta, 'meta');
};

export const fetchTweets = async (q: TweetQuery): Promise<Page<Tweet>> => {
  const url = buildUrl('/api/tweets', {
    q: q.q, from: q.from, to: q.to,
    type: q.type === 'all' ? undefined : q.type,
    media: q.media, order: q.order,
    removed: q.removed === 'include' ? undefined : q.removed, cursor: q.cursor, limit: q.limit,
  });
  return expect(url, await getJson(url), isPageOf(isTweetLike), 'tweets');
};

export const fetchTweetDetail = async (id: string): Promise<TweetDetail> => {
  const url = `/api/tweets/${encodeURIComponent(id)}`;
  return expect(url, await getJson(url), isTweetDetail, 'tweet');
};

/** 配列、または { months | items: [...] } のどちらでも受け付ける */
export const fetchCalendar = async (): Promise<readonly MonthCount[]> => {
  const url = '/api/calendar';
  const body = await getJson(url);
  const list = Array.isArray(body) ? body : isRecord(body) ? (body['months'] ?? body['items']) : undefined;
  if (!Array.isArray(list) || !list.every(isMonth)) {
    console.error(`[api] unexpected shape for calendar: ${url}`, body);
    throw new ApiFailure('calendar の形式が想定と異なります', 0);
  }
  return list;
};

export const fetchLikes = async (q: string | undefined, cursor: string | null): Promise<Page<Like>> => {
  const url = buildUrl('/api/likes', { q, cursor: cursor ?? undefined });
  return expect(url, await getJson(url), isPageOf(isLike), 'likes');
};

/** 配列、または Page のどちらでも受け付ける */
export const fetchConversations = async (): Promise<readonly DmConversation[]> => {
  const url = '/api/dm';
  const body = await getJson(url);
  const list = Array.isArray(body) ? body : isRecord(body) ? body['items'] : undefined;
  if (!Array.isArray(list) || !list.every(isConv)) {
    console.error(`[api] unexpected shape for dm list: ${url}`, body);
    throw new ApiFailure('DM一覧の形式が想定と異なります', 0);
  }
  return list;
};

export const fetchMessages = async (id: string, cursor: string | null): Promise<Page<DmMessage>> => {
  const url = buildUrl(`/api/dm/${encodeURIComponent(id)}`, { cursor: cursor ?? undefined });
  return expect(url, await getJson(url), isPageOf(isMsg), 'dm messages');
};

// ---- 管理 ----

export const fetchArchives = async (): Promise<readonly ArchiveFile[]> => {
  const url = '/api/admin/archives';
  const body = await getJson(url);
  const list = Array.isArray(body) ? body : isRecord(body) ? body['items'] : undefined;
  if (!Array.isArray(list) || !list.every(isArchiveFile)) {
    console.error(`[api] unexpected shape for archives: ${url}`, body);
    throw new ApiFailure('アーカイブ一覧の形式が想定と異なります', 0);
  }
  return list;
};

export const fetchImports = async (): Promise<readonly ImportRecord[]> => {
  const url = '/api/admin/imports';
  const body = await getJson(url);
  const list = Array.isArray(body) ? body : isRecord(body) ? body['items'] : undefined;
  if (!Array.isArray(list) || !list.every(isImportRecord)) {
    console.error(`[api] unexpected shape for imports: ${url}`, body);
    throw new ApiFailure('取り込み履歴の形式が想定と異なります', 0);
  }
  return list;
};

/** ジョブが無ければ null */
export const fetchImportStatus = async (): Promise<ImportJob | null> => {
  const url = '/api/admin/import/status';
  const body = await getJson(url);
  if (body === null) return null;
  return expect(url, body, isImportJob, 'import status');
};

export const startImport = async (req: ImportRequest): Promise<ImportJob> => {
  const url = '/api/admin/import';
  return expect(url, await postJson(url, req), isImportJob, 'import job');
};

export const resetDatabase = async (): Promise<void> => {
  const req: ResetRequest = { confirm: 'RESET' };
  await postJson('/api/admin/reset', req);
};
