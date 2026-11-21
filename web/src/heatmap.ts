import type { DailyCount } from '../../src/shared/types.ts';
import { createTooltip, observeWidth } from './charts.ts';
import { h, sv } from './dom.ts';
import { emptyBox, errorBox, spinner } from './feed.ts';
import { formatCount } from './format.ts';
import { timelineHash } from './route.ts';

export type Heatmap = { readonly el: HTMLElement; readonly destroy: () => void };

export type HeatmapProps = {
  /** ツイートがある年 (昇順) */
  readonly years: readonly number[];
  readonly account: string | undefined;
  readonly load: (year: number) => Promise<readonly DailyCount[]>;
};

const GUTTER = 22;
const TOP = 18;
const GAP = 2;
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'] as const;
const DAY_MS = 86_400_000;

type Cell = { readonly day: string; readonly col: number; readonly row: number; readonly weekday: number; readonly month: number; readonly date: number };

/** 暦日として年のセルを並べる。UTC の日付計算だけを使うのでブラウザのタイムゾーンに依存しない。週は月曜始まり */
export const buildYear = (year: number): { readonly cells: readonly Cell[]; readonly cols: number } => {
  const start = Date.UTC(year, 0, 1);
  const days = Math.round((Date.UTC(year + 1, 0, 1) - start) / DAY_MS);
  const offset = (new Date(start).getUTCDay() + 6) % 7;
  const cells = Array.from({ length: days }, (_, i): Cell => {
    const d = new Date(start + i * DAY_MS);
    const idx = offset + i;
    return { day: d.toISOString().slice(0, 10), col: Math.floor(idx / 7), row: idx % 7, weekday: d.getUTCDay(), month: d.getUTCMonth() + 1, date: d.getUTCDate() };
  });
  return { cells, cols: Math.ceil((offset + days) / 7) };
};

/** 0 件は 0、それ以外は件数の四分位で 1〜4 */
export const levelFn = (counts: readonly number[]): ((c: number) => 0 | 1 | 2 | 3 | 4) => {
  const sorted = counts.filter((c) => c > 0).sort((a, b) => a - b);
  const q = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
  const [t1, t2, t3] = [q(0.25), q(0.5), q(0.75)];
  return (c) => (c <= 0 ? 0 : c <= t1 ? 1 : c <= t2 ? 2 : c <= t3 ? 3 : 4);
};

export const createHeatmap = (props: HeatmapProps): Heatmap => {
  const years = [...props.years].sort((a, b) => b - a);
  const latest = years[0];
  if (latest === undefined) return { el: emptyBox('データがありません'), destroy: () => undefined };

  let year = latest;
  let data: readonly DailyCount[] | null = null;
  let avail = 320;
  let token = 0;
  let alive = true;
  const cache = new Map<number, readonly DailyCount[]>();

  const select = h('select', { class: 'hm-year', 'aria-label': '年を選択' }, years.map((y) => h('option', { value: y }, `${y}年`)));
  const total = h('span', { class: 'muted hm-total' });
  const scroll = h('div', { class: 'hm-scroll', tabindex: 0, role: 'group', 'aria-label': '日別カレンダー (横にスクロールできます)' });
  const status = h('div', { class: 'hm-status' });
  const legend = h('div', { class: 'hm-legend', 'aria-hidden': 'true' },
    h('span', null, '少'),
    [0, 1, 2, 3, 4].map((l) => h('span', { class: `hm-sw lv${l}` })),
    h('span', null, '多'));
  const wrap = h('div', { class: 'chart-wrap hm-wrap' },
    h('div', { class: 'hm-head' }, select, total),
    status, scroll, legend);
  const tip = createTooltip(wrap);
  wrap.append(tip.el);
  scroll.addEventListener('scroll', tip.hide, { passive: true });

  const draw = (rows: readonly DailyCount[]): void => {
    tip.hide();
    const counts = new Map(rows.map((r) => [r.day, r.count] as const));
    const level = levelFn([...counts.values()]);
    const { cells, cols } = buildYear(year);
    const step = avail >= 560 ? Math.min(16, Math.max(10, Math.floor((avail - GUTTER) / cols))) : 13;
    const size = step - GAP;
    const width = GUTTER + cols * step;
    const height = TOP + 7 * step;
    const sum = rows.reduce((a, r) => a + r.count, 0);
    total.textContent = `${formatCount(sum)} 件`;

    const svg = sv('svg', { class: 'hm-svg', width, height, role: 'img',
      'aria-label': `${year}年の日別ツイート数カレンダー。合計 ${formatCount(sum)} 件、ツイートのあった日 ${counts.size} 日。` });
    for (const r of [0, 2, 4]) svg.append(sv('text', { class: 'ax-text', x: 0, y: TOP + r * step + size - 1 }, WEEKDAYS[(r + 1) % 7] ?? ''));
    for (const c of cells) {
      const x = GUTTER + c.col * step;
      const y = TOP + c.row * step;
      if (c.date === 1) svg.append(sv('text', { class: 'ax-text', x, y: TOP - 6 }, `${c.month}月`));
      const n = counts.get(c.day) ?? 0;
      const label = `${c.day.replaceAll('-', '/')} (${WEEKDAYS[c.weekday] ?? ''}) ${formatCount(n)}件`;
      const rect = sv('rect', { class: `hm-cell lv${level(n)}`, x, y, width: size, height: size, rx: 2, 'data-day': c.day, 'data-count': n }, sv('title', null, label));
      tip.attach(rect, rect, [label], timelineHash({ from: c.day, to: c.day }, props.account), 'この日のツイートを見る →');
      svg.append(rect);
    }
    const keep = scroll.scrollLeft;
    scroll.replaceChildren(svg);
    if (year === latest) {
      // 最新の年は、最後にツイートのあった週が右端に見える位置までスクロールする
      const lastDay = rows.reduce((a, r) => (r.count > 0 && r.day > a ? r.day : a), '');
      const lastCell = cells.find((c) => c.day === lastDay);
      scroll.scrollLeft = lastCell ? GUTTER + (lastCell.col + 1) * step - scroll.clientWidth + step : scroll.scrollWidth;
    } else {
      scroll.scrollLeft = keep;
    }
  };

  const show = (): void => {
    status.replaceChildren(...(data !== null && data.length === 0 ? [emptyBox('この年のツイートはありません')] : []));
    if (data !== null) draw(data);
  };

  const loadYear = (): void => {
    const y = year;
    const mine = ++token;
    const hit = cache.get(y);
    if (hit) {
      data = hit;
      show();
      return;
    }
    data = null;
    scroll.replaceChildren();
    total.textContent = '';
    status.replaceChildren(spinner());
    props.load(y).then((rows) => {
      if (!alive || mine !== token) return;
      cache.set(y, rows);
      data = rows;
      show();
    }).catch((e: unknown) => {
      if (!alive || mine !== token) return;
      console.error(`[heatmap] daily load failed for ${y}`, e);
      status.replaceChildren(errorBox(`日別データを取得できませんでした: ${e instanceof Error ? e.message : String(e)}`, loadYear));
    });
  };

  select.value = String(year);
  select.addEventListener('change', () => {
    year = Number(select.value);
    loadYear();
  });

  const stopObserving = observeWidth(scroll, (w) => {
    if (w <= 0 || w === avail) return;
    avail = w;
    if (data !== null) draw(data);
  });

  loadYear();
  return {
    el: wrap,
    destroy: () => {
      alive = false;
      stopObserving();
      tip.destroy();
    },
  };
};
