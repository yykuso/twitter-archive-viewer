import type { RemovedFilter, TweetQuery, TweetType } from '../../src/shared/types.ts';

export type Route =
  | { readonly kind: 'timeline'; readonly query: TweetQuery }
  | { readonly kind: 'tweet'; readonly id: string }
  | { readonly kind: 'likes'; readonly q: string }
  | { readonly kind: 'dmList' }
  | { readonly kind: 'dm'; readonly id: string }
  | { readonly kind: 'admin' };

const REMOVED: readonly RemovedFilter[] = ['include', 'exclude', 'only'];
const TYPES: readonly TweetType[] = ['all', 'original', 'reply', 'retweet'];

export const parseHash = (hash: string): Route => {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const qi = raw.indexOf('?');
  const path = qi >= 0 ? raw.slice(0, qi) : raw;
  const sp = new URLSearchParams(qi >= 0 ? raw.slice(qi + 1) : '');
  const parts = path.split('/').filter((p) => p !== '');
  const [a, b] = parts;
  if (a === 't' && b) return { kind: 'tweet', id: decodeURIComponent(b) };
  if (a === 'admin') return { kind: 'admin' };
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
};

const toSearch = (entries: readonly (readonly [string, string | undefined])[]): string => {
  const sp = new URLSearchParams();
  for (const [k, v] of entries) if (v !== undefined && v !== '') sp.set(k, v);
  const s = sp.toString();
  return s ? `?${s}` : '';
};

export const timelineHash = (q: TweetQuery): string =>
  `#/${toSearch([
    ['q', q.q], ['from', q.from], ['to', q.to],
    ['type', q.type === 'all' ? undefined : q.type],
    ['media', q.media], ['order', q.order === 'asc' ? 'asc' : undefined],
    ['removed', q.removed === 'include' ? undefined : q.removed],
  ])}`;

export const likesHash = (q: string): string => `#/likes${toSearch([['q', q]])}`;
export const tweetHash = (id: string): string => `#/t/${encodeURIComponent(id)}`;
export const dmHash = (id: string): string => `#/dm/${encodeURIComponent(id)}`;

export const sameQuery = (a: TweetQuery, b: TweetQuery): boolean => timelineHash(a) === timelineHash(b);
