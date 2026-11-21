const pad = (n: number): string => String(n).padStart(2, '0');

type DayParts = { readonly y: string; readonly mo: string; readonly d: string; readonly h: string; readonly mi: string };

let timeZone = 'UTC';
let formatter = makeFormatter(timeZone);

function makeFormatter(tz: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** 表示に使うタイムゾーン (IANA 名, Meta.timezone) を設定する。起動時と meta 再取得時に呼ぶ。不正な名前は例外 */
export const setDisplayTimeZone = (tz: string): void => {
  formatter = makeFormatter(tz);
  timeZone = tz;
};

export const getDisplayTimeZone = (): string => timeZone;

const partsOf = (ms: number): DayParts => {
  const m = new Map<string, string>();
  for (const p of formatter.formatToParts(ms)) m.set(p.type, p.value);
  return { y: m.get('year') ?? '', mo: m.get('month') ?? '', d: m.get('day') ?? '', h: m.get('hour') ?? '', mi: m.get('minute') ?? '' };
};

/** ISO 8601 → "YYYY/MM/DD HH:mm" (設定タイムゾーン)。不正値はそのまま返す */
export const formatDateTime = (iso: string): string => {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const p = partsOf(t);
  return `${p.y}/${p.mo}/${p.d} ${p.h}:${p.mi}`;
};

/** ISO 8601 → "YYYY-MM-DD" (設定タイムゾーン) */
export const dayKey = (iso: string): string => {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const p = partsOf(t);
  return `${p.y}-${p.mo}-${p.d}`;
};

export const formatDay = (iso: string): string => dayKey(iso).replaceAll('-', '/');

export const formatCount = (n: number): string => n.toLocaleString('ja-JP');

/** "YYYY-MM" → その月の [from, to] (YYYY-MM-DD) */
export const monthRange = (month: string): { from: string; to: string } | null => {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return { from: `${m[1]}-${m[2]}-01`, to: `${m[1]}-${m[2]}-${pad(last)}` };
};
