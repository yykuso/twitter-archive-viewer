// 統計の集計 (純粋関数)。行は created_at 昇順で渡す。月・日の境界は設定タイムゾーンの 0:00 (UTC ms)。
import type { DailyCount, MonthlyStats } from '../shared/types.ts';
import { localMonth, nextDay, nextMonth, zonedMidnightToUtc } from './timezone.ts';

/** ツイート 1 行分の統計用の値 (インデックスだけで取れる列) */
export type StatRow = {
  readonly createdAt: number;
  readonly isReply: boolean;
  readonly isRetweet: boolean;
  readonly hasMedia: boolean;
  readonly deleted: boolean;
};

export type TweetKind = 'original' | 'reply' | 'retweet';

/** リツイート > リプライ > オリジナル の優先で 1 件を 1 種類に分類する (合計が総数に一致する) */
export const kindOf = (r: Pick<StatRow, 'isReply' | 'isRetweet'>): TweetKind =>
  r.isRetweet ? 'retweet' : r.isReply ? 'reply' : 'original';

const midnight = (date: string, timeZone: string): number => {
  const ms = zonedMidnightToUtc(date, timeZone);
  if (ms === null) throw new Error(`stats: invalid date ${date}`);
  return ms;
};

/** first〜last を含む月 ('YYYY-MM') と境界 (bounds[i] 以上 bounds[i+1] 未満が months[i])。bounds の長さは months+1 */
export const monthBuckets = (firstMs: number, lastMs: number, timeZone: string): { months: string[]; bounds: number[] } => {
  const months: string[] = [];
  const bounds: number[] = [];
  const lastMonth = localMonth(lastMs, timeZone);
  for (let m = localMonth(firstMs, timeZone); m <= lastMonth; m = nextMonth(m)) {
    months.push(m);
    bounds.push(midnight(`${m}-01`, timeZone));
  }
  bounds.push(midnight(`${nextMonth(lastMonth)}-01`, timeZone));
  return { months, bounds };
};

/** その年の全日 ('YYYY-MM-DD') と境界 (長さは days+1) */
export const dayBuckets = (year: number, timeZone: string): { days: string[]; bounds: number[] } => {
  const y = String(year).padStart(4, '0');
  const days: string[] = [];
  const bounds: number[] = [];
  for (let d = `${y}-01-01`; d.startsWith(`${y}-`); d = nextDay(d)) {
    days.push(d);
    bounds.push(midnight(d, timeZone));
  }
  bounds.push(midnight(`${String(year + 1).padStart(4, '0')}-01-01`, timeZone));
  return { days, bounds };
};

export type Totals = {
  tweets: number;
  original: number;
  replies: number;
  retweets: number;
  withMedia: number;
  deleted: number;
};

/** created_at 昇順の行から、月別件数と種別合計を 1 パスで数える */
export const aggregateMonthly = (
  rows: Iterable<StatRow>,
  months: readonly string[],
  bounds: readonly number[],
): { monthly: MonthlyStats[]; totals: Totals } => {
  const counts = months.map(() => ({ original: 0, reply: 0, retweet: 0 }));
  const totals: Totals = { tweets: 0, original: 0, replies: 0, retweets: 0, withMedia: 0, deleted: 0 };
  let i = 0;
  for (const r of rows) {
    while (i < months.length - 1 && r.createdAt >= (bounds[i + 1] ?? Infinity)) i += 1;
    const bucket = counts[i];
    if (bucket === undefined) throw new Error('stats: no month bucket');
    const kind = kindOf(r);
    bucket[kind] += 1;
    totals.tweets += 1;
    if (kind === 'original') totals.original += 1;
    else if (kind === 'reply') totals.replies += 1;
    else totals.retweets += 1;
    if (r.hasMedia) totals.withMedia += 1;
    if (r.deleted) totals.deleted += 1;
  }
  return { monthly: months.map((month, k) => ({ month, ...(counts[k] ?? { original: 0, reply: 0, retweet: 0 }) })), totals };
};

/** 月別から「ツイートがある年」(昇順) */
export const yearsWithTweets = (monthly: readonly MonthlyStats[]): number[] => {
  const years = new Set<number>();
  for (const m of monthly) if (m.original + m.reply + m.retweet > 0) years.add(Number(m.month.slice(0, 4)));
  return [...years].sort((a, b) => a - b);
};

/** created_at 昇順の時刻から日別件数 (0 件の日は含めない) */
export const aggregateDaily = (times: Iterable<number>, days: readonly string[], bounds: readonly number[]): DailyCount[] => {
  const counts = new Array<number>(days.length).fill(0);
  let i = 0;
  for (const t of times) {
    while (i < days.length - 1 && t >= (bounds[i + 1] ?? Infinity)) i += 1;
    counts[i] = (counts[i] ?? 0) + 1;
  }
  return days.flatMap((day, k) => ((counts[k] ?? 0) > 0 ? [{ day, count: counts[k] ?? 0 }] : []));
};
