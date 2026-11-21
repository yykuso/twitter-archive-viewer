import type { RemovedFilter, TweetType } from '../shared/types.ts';
import { HttpError } from './http.ts';
import { nextDay, zonedMidnightToUtc } from './timezone.ts';

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;
const MAX_TERMS = 5;
const MAX_Q_LENGTH = 500;

export type KeysetCursor = { readonly createdAt: number; readonly id: string };

export type TweetFilter = {
  readonly terms: readonly string[];
  /** UTC ms, 含む */
  readonly fromMs: number | null;
  /** UTC ms, 含まない */
  readonly toMs: number | null;
  readonly type: TweetType;
  readonly mediaOnly: boolean;
  readonly order: 'asc' | 'desc';
  readonly removed: RemovedFilter;
  readonly cursor: KeysetCursor | null;
  readonly limit: number;
};

export const parseLimit = (raw: string | null): number => {
  if (raw === null || raw === '') return DEFAULT_LIMIT;
  if (!/^\d{1,6}$/.test(raw)) throw new HttpError(400, 'invalid limit');
  const n = Number(raw);
  if (n < 1) throw new HttpError(400, 'invalid limit');
  return Math.min(n, MAX_LIMIT);
};

export const parseTerms = (raw: string | null): readonly string[] => {
  if (raw === null) return [];
  if (raw.length > MAX_Q_LENGTH) throw new HttpError(400, 'q too long');
  return raw.split(/\s+/).filter((t) => t !== '').slice(0, MAX_TERMS);
};

/** YYYY-MM-DD (設定タイムゾーン) の 0:00 を UTC ms で返す。不正な日付は 400 */
export const dayStartMs = (raw: string, name: string, timeZone: string): number => {
  const ms = zonedMidnightToUtc(raw, timeZone);
  if (ms === null) throw new HttpError(400, `invalid ${name}`);
  return ms;
};

export const encodeCursor = (createdAt: number, id: string): string => `${createdAt}_${id}`;

export const parseKeysetCursor = (raw: string | null): KeysetCursor | null => {
  if (raw === null || raw === '') return null;
  const m = /^(\d{1,16})_([0-9A-Za-z-]{1,40})$/.exec(raw);
  if (m === null) throw new HttpError(400, 'invalid cursor');
  return { createdAt: Number(m[1]), id: m[2] ?? '' };
};

export const parseOrdCursor = (raw: string | null): number | null => {
  if (raw === null || raw === '') return null;
  if (!/^\d{1,12}$/.test(raw)) throw new HttpError(400, 'invalid cursor');
  return Number(raw);
};

const parseType = (raw: string | null): TweetType => {
  if (raw === null || raw === '' || raw === 'all') return 'all';
  if (raw === 'original' || raw === 'reply' || raw === 'retweet') return raw;
  throw new HttpError(400, 'invalid type');
};

const parseOrder = (raw: string | null): 'asc' | 'desc' => {
  if (raw === null || raw === '' || raw === 'desc') return 'desc';
  if (raw === 'asc') return 'asc';
  throw new HttpError(400, 'invalid order');
};

const parseRemoved = (raw: string | null): RemovedFilter => {
  if (raw === null || raw === '' || raw === 'include') return 'include';
  if (raw === 'exclude' || raw === 'only') return raw;
  throw new HttpError(400, 'invalid removed');
};

export const parseTweetFilter = (sp: URLSearchParams, timeZone: string): TweetFilter => {
  const from = sp.get('from');
  const to = sp.get('to');
  const media = sp.get('media');
  if (media !== null && media !== '' && media !== '1' && media !== '0') {
    throw new HttpError(400, 'invalid media');
  }
  const fromMs = from === null || from === '' ? null : dayStartMs(from, 'from', timeZone);
  const toMs = to === null || to === '' ? null : (dayStartMs(to, 'to', timeZone), dayStartMs(nextDay(to), 'to', timeZone));
  if (fromMs !== null && toMs !== null && fromMs >= toMs) throw new HttpError(400, 'from is after to');
  return {
    terms: parseTerms(sp.get('q')),
    fromMs,
    toMs,
    type: parseType(sp.get('type')),
    mediaOnly: media === '1',
    order: parseOrder(sp.get('order')),
    removed: parseRemoved(sp.get('removed')),
    cursor: parseKeysetCursor(sp.get('cursor')),
    limit: parseLimit(sp.get('limit')),
  };
};
