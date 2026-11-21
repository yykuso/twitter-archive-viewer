// タイムゾーン (IANA 名) に関する純粋なヘルパー。日付絞り込みと月別集計で使う。

const formatterCache = new Map<string, Intl.DateTimeFormat>();

const formatterFor = (timeZone: string): Intl.DateTimeFormat => {
  const hit = formatterCache.get(timeZone);
  if (hit !== undefined) return hit;
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  formatterCache.set(timeZone, f);
  return f;
};

/** IANA 名として不正なら例外 (起動時の検証用) */
export const assertValidTimeZone = (timeZone: string): void => {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone });
  } catch (e) {
    throw new Error(`TIMEZONE "${timeZone}" is not a valid IANA time zone name (e.g. Asia/Tokyo, America/New_York): ${e instanceof Error ? e.message : String(e)}`);
  }
};

type LocalParts = { readonly y: number; readonly mo: number; readonly d: number; readonly h: number; readonly mi: number; readonly s: number };

const localParts = (ms: number, timeZone: string): LocalParts => {
  const get = new Map<string, number>();
  for (const p of formatterFor(timeZone).formatToParts(ms)) get.set(p.type, Number(p.value));
  const field = (k: string): number => {
    const v = get.get(k);
    if (v === undefined || Number.isNaN(v)) throw new Error(`timezone: missing ${k} for ${timeZone}`);
    return v;
  };
  return { y: field('year'), mo: field('month'), d: field('day'), h: field('hour'), mi: field('minute'), s: field('second') };
};

/** その瞬間のタイムゾーンの UTC からのオフセット (ms)。東が正 */
export const zoneOffsetMs = (ms: number, timeZone: string): number => {
  const p = localParts(ms, timeZone);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
};

/** YYYY-MM-DD の現地 0:00 を UTC ms で返す (DST 対応)。形式・暦として不正なら null */
export const zonedMidnightToUtc = (dateStr: string, timeZone: string): number | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (m === null) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const guess = Date.UTC(y, mo - 1, d);
  const check = new Date(guess);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  const o1 = zoneOffsetMs(guess - zoneOffsetMs(guess, timeZone), timeZone);
  const t = guess - o1;
  const o2 = zoneOffsetMs(t, timeZone);
  return o2 === o1 ? t : guess - o2;
};

/** YYYY-MM-DD の翌日 (暦計算のみ) */
export const nextDay = (dateStr: string): string => {
  const [y, mo, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y ?? 0, (mo ?? 1) - 1, (d ?? 1) + 1)).toISOString().slice(0, 10);
};

/** UTC ms → 現地の "YYYY-MM" */
export const localMonth = (ms: number, timeZone: string): string => {
  const p = localParts(ms, timeZone);
  return `${String(p.y).padStart(4, '0')}-${String(p.mo).padStart(2, '0')}`;
};

/** "YYYY-MM" の翌月 */
export const nextMonth = (month: string): string => {
  const [y, mo] = month.split('-').map(Number);
  const t = new Date(Date.UTC(y ?? 0, mo ?? 1, 1));
  return `${String(t.getUTCFullYear()).padStart(4, '0')}-${String(t.getUTCMonth() + 1).padStart(2, '0')}`;
};

/** 自己検査 (起動時に実行)。失敗なら例外 */
export const selfCheckTimeZone = (): void => {
  const cases: readonly [string, string, number][] = [
    ['2024-03-10', 'America/New_York', Date.UTC(2024, 2, 10, 5)], // DST 開始日: 0:00 は EST (-5)
    ['2024-03-11', 'America/New_York', Date.UTC(2024, 2, 11, 4)], // 翌日は EDT (-4)
    ['2024-11-03', 'America/New_York', Date.UTC(2024, 10, 3, 4)], // DST 終了日: 0:00 は EDT
    ['2024-05-01', 'Asia/Tokyo', Date.UTC(2024, 3, 30, 15)],
    ['2024-01-01', 'UTC', Date.UTC(2024, 0, 1)],
  ];
  for (const [date, tz, expected] of cases) {
    const got = zonedMidnightToUtc(date, tz);
    if (got !== expected) throw new Error(`timezone self-check failed: ${date} ${tz} expected ${expected} got ${String(got)}`);
  }
};
