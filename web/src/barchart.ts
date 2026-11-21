import type { MonthlyStats } from '../../src/shared/types.ts';
import { createTooltip, niceTicks, observeWidth } from './charts.ts';
import { h, sv } from './dom.ts';
import { formatCount, monthRange } from './format.ts';
import { timelineHash } from './route.ts';

export type BarChart = {
  readonly el: HTMLElement;
  /** 表示する月を差し替える。最新の月が見えるよう右端までスクロールする */
  readonly setMonths: (months: readonly MonthlyStats[]) => void;
  readonly destroy: () => void;
};

const HEIGHT = 220;
const PAD_TOP = 10;
const PAD_BOTTOM = 24;
const AXIS_W = 42;
const MIN_STEP = 14;
const FALLBACK_W = 300;

const SERIES = [
  { key: 'original', label: 'オリジナル', cls: 'seg-original' },
  { key: 'reply', label: 'リプライ', cls: 'seg-reply' },
  { key: 'retweet', label: 'RT', cls: 'seg-retweet' },
] as const;

const totalOf = (m: MonthlyStats): number => m.original + m.reply + m.retweet;
const monthLabel = (month: string): string => `${month.slice(0, 4)}年${Number(month.slice(5, 7))}月`;

const summaryOf = (months: readonly MonthlyStats[]): string => {
  const first = months[0];
  const last = months[months.length - 1];
  if (!first || !last) return '月別ツイート数の積み上げ棒グラフ (データなし)';
  const total = months.reduce((a, m) => a + totalOf(m), 0);
  const peak = months.reduce((a, m) => (totalOf(m) > totalOf(a) ? m : a), first);
  return `月別ツイート数の積み上げ棒グラフ。${first.month} から ${last.month} まで ${months.length} か月、合計 ${formatCount(total)} 件。最多は ${peak.month} の ${formatCount(totalOf(peak))} 件。`;
};

export const createBarChart = (account: string | undefined): BarChart => {
  let months: readonly MonthlyStats[] = [];
  let avail = FALLBACK_W;
  let measured = false;
  let toEnd = true;

  const yAxis = sv('svg', { class: 'chart-yaxis', width: AXIS_W, height: HEIGHT, 'aria-hidden': 'true' });
  const scroll = h('div', { class: 'chart-scroll', tabindex: 0, role: 'group', 'aria-label': '月別グラフ (横にスクロールできます)' });
  const legend = h('ul', { class: 'chart-legend' }, SERIES.map((s) =>
    h('li', null, h('span', { class: `swatch ${s.cls}`, 'aria-hidden': 'true' }), s.label)));
  const wrap = h('div', { class: 'chart-wrap' }, h('div', { class: 'chart-body' }, yAxis, scroll), legend);
  const tip = createTooltip(wrap);
  wrap.append(tip.el);
  scroll.addEventListener('scroll', tip.hide, { passive: true });

  const render = (): void => {
    tip.hide();
    const n = months.length;
    const step = n === 0 ? avail : Math.max(MIN_STEP, avail / n);
    const bw = Math.min(44, Math.max(6, step * 0.72));
    const width = Math.max(avail, n * step);
    const plotH = HEIGHT - PAD_TOP - PAD_BOTTOM;
    const ticks = niceTicks(months.reduce((a, m) => Math.max(a, totalOf(m)), 0));
    const top = ticks[ticks.length - 1] ?? 1;
    const y = (v: number): number => PAD_TOP + plotH * (1 - v / top);

    yAxis.replaceChildren(...ticks.map((t) =>
      sv('text', { class: 'ax-text', x: AXIS_W - 6, y: y(t) + 4, 'text-anchor': 'end' }, formatCount(t))));

    const plot = sv('svg', { class: 'chart-plot', width, height: HEIGHT, role: 'img', 'aria-label': summaryOf(months) });
    for (const t of ticks) plot.append(sv('line', { class: t === 0 ? 'ax-base' : 'ax-grid', x1: 0, x2: width, y1: y(t), y2: y(t) }));

    months.forEach((m, i) => {
      const x0 = i * step;
      const bx = x0 + (step - bw) / 2;
      const total = totalOf(m);
      const g = sv('g', { class: 'bar-g' });
      const hit = sv('rect', { class: 'bar-hit', x: x0, y: PAD_TOP, width: step, height: plotH });
      g.append(hit,
        sv('title', null, `${monthLabel(m.month)}: オリジナル ${formatCount(m.original)} / リプライ ${formatCount(m.reply)} / RT ${formatCount(m.retweet)} / 合計 ${formatCount(total)}`));
      let acc = 0;
      let anchor: Element = hit;
      for (const s of SERIES) {
        const v = m[s.key];
        if (v <= 0) continue;
        const seg = sv('rect', { class: `seg ${s.cls}`, x: bx, y: y(acc + v), width: bw, height: y(acc) - y(acc + v) });
        g.append(seg);
        anchor = seg;
        acc += v;
      }
      plot.append(g);
      const r = monthRange(m.month);
      if (r) {
        tip.attach(g, anchor, [
          h('strong', null, monthLabel(m.month)),
          ...SERIES.map((s) => h('span', { class: 'tip-row' }, h('span', { class: `swatch ${s.cls}`, 'aria-hidden': 'true' }), `${s.label} ${formatCount(m[s.key])}`)),
          `合計 ${formatCount(total)} 件`,
        ], timelineHash({ from: r.from, to: r.to }, account), 'この月のツイートを見る →');
      }
      const mo = Number(m.month.slice(5, 7));
      if (mo === 1 || n <= 24) {
        plot.append(sv('text', { class: 'ax-text', x: mo === 1 ? x0 : x0 + step / 2, y: HEIGHT - 7, 'text-anchor': mo === 1 ? 'start' : 'middle' }, mo === 1 ? m.month.slice(0, 4) : `${mo}月`));
      }
    });

    const keepLeft = scroll.scrollLeft;
    scroll.replaceChildren(plot);
    scroll.scrollLeft = toEnd ? scroll.scrollWidth : keepLeft;
    if (measured) toEnd = false;
  };

  const stopObserving = observeWidth(scroll, (w) => {
    if (w <= 0) return;
    avail = w;
    measured = true;
    render();
  });

  return {
    el: wrap,
    setMonths: (next) => {
      months = next;
      toEnd = true;
      render();
    },
    destroy: () => {
      stopObserving();
      tip.destroy();
    },
  };
};
