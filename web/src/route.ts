import type { RemovedFilter, TweetQuery, TweetType } from '../../src/shared/types.ts';

export type Route =
  | { readonly kind: 'timeline'; readonly query: TweetQuery }
  | { readonly kind: 'tweet'; readonly id: string }
  | { readonly kind: 'likes'; readonly q: string }
  | { readonly kind: 'dmList' }
  | { readonly kind: 'dm'; readonly id: string }
  | { readonly kind: 'stats' }
  | { readonly kind: 'admin' };

/** ハッシュの解析結果。account はクエリ `account=` の値 (無ければ undefined) */
export type Parsed = { readonly route: Route; readonly account: string | undefined };

const REMOVED: readonly RemovedFilter[] = ['include', 'exclude', 'only'];
const TYPES: readonly TweetType[] = ['all', 'original', 'reply', 'retweet'];

const splitHash = (hash: string): { path: string; sp: URLSearchParams } => {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const qi = raw.indexOf('?');
  return { path: qi >= 0 ? raw.slice(0, qi) : raw, sp: new URLSearchParams(qi >= 0 ? raw.slice(qi + 1) : '') };
};

export const parseHash = (hash: string): Parsed => {
  const { path, sp } = splitHash(hash);
  const account = sp.get('account') || undefined;
  const parts = path.split('/').filter((p) => p !== '');
  const [a, b] = parts;
  const route = ((): Route => {
    if (a === 't' && b) return { kind: 'tweet', id: decodeURIComponent(b) };
    if (a === 'admin') return { kind: 'admin' };
    if (a === 'stats') return { kind: 'stats' };
    if (a === 'likes') return { kind: 'likes', q: sp.get('q') ?? '' };
    if (a === 'dm') return b ? { kind: 'dm', id: decodeURIComponent(b) } : { kind: 'dmList' };
    const type = sp.get('type');
    const order = sp.get('order');
    const removed = sp.get('removed');
    const query: TweetQuery = {
      ...(sp.get('q') ? { q: sp.get('q') as string } : {}),
      ...(sp.get('from') ? { from: sp.get('from') as string } : {}),
      ...(sp.get('to') ? { to: sp.get('to') as string } : {}),
      ...(type && (TYPES as readonly string[]).includes(type) && type !== 'all' ? { type: type as TweetType } : {}),
      ...(sp.get('media') === '1' ? { media: '1' as const } : {}),
      ...(order === 'asc' ? { order: 'asc' as const } : {}),
      ...(removed && (REMOVED as readonly string[]).includes(removed) && removed !== 'include' ? { removed: removed as RemovedFilter } : {}),
    };
    return { kind: 'timeline', query };
  })();
  return { route, account };
};

const toSearch = (entries: readonly (readonly [string, string | undefined])[]): string => {
  const sp = new URLSearchParams();
  for (const [k, v] of entries) if (v !== undefined && v !== '') sp.set(k, v);
  const s = sp.toString();
  return s ? `?${s}` : '';
};

// すべてのハッシュは account を (あれば) 先頭のクエリとして保持する

export const timelineHash = (q: TweetQuery, account: string | undefined): string =>
  `#/${toSearch([
    ['account', account],
    ['q', q.q], ['from', q.from], ['to', q.to],
    ['type', q.type === 'all' ? undefined : q.type],
    ['media', q.media], ['order', q.order === 'asc' ? 'asc' : undefined],
    ['removed', q.removed === 'include' ? undefined : q.removed],
  ])}`;

export const likesHash = (q: string, account: string | undefined): string => `#/likes${toSearch([['account', account], ['q', q]])}`;
export const tweetHash = (id: string, account: string | undefined): string => `#/t/${encodeURIComponent(id)}${toSearch([['account', account]])}`;
export const dmListHash = (account: string | undefined): string => `#/dm${toSearch([['account', account]])}`;
export const dmHash = (id: string, account: string | undefined): string => `#/dm/${encodeURIComponent(id)}${toSearch([['account', account]])}`;
export const statsHash = (account: string | undefined): string => `#/stats${toSearch([['account', account]])}`;
export const adminHash = (account: string | undefined): string => `#/admin${toSearch([['account', account]])}`;

/** 現在のハッシュの account だけを差し替える (undefined で削除)。他のクエリはそのまま */
export const withAccountParam = (hash: string, account: string | undefined): string => {
  const { path, sp } = splitHash(hash);
  const out = new URLSearchParams();
  if (account !== undefined && account !== '') out.set('account', account);
  for (const [k, v] of sp) if (k !== 'account') out.append(k, v);
  const qs = out.toString();
  return `#${path === '' ? '/' : path}${qs ? `?${qs}` : ''}`;
};

/** アカウントを切り替えたときの移動先。アカウント固有の詳細画面は一覧に戻す */
export const switchTargetHash = (route: Route, account: string): string => {
  switch (route.kind) {
    case 'likes': return likesHash('', account);
    case 'dmList':
    case 'dm': return dmListHash(account);
    case 'stats': return statsHash(account);
    case 'admin': return adminHash(account);
    case 'timeline':
    case 'tweet': return timelineHash({}, account);
  }
};

export const sameQuery = (a: TweetQuery, b: TweetQuery): boolean => timelineHash(a, undefined) === timelineHash(b, undefined);
