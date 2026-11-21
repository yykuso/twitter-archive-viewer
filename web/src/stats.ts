import type { MonthlyStats, StatsSummary } from '../../src/shared/types.ts';
import type { Scope } from './account.ts';
import { fetchDaily, fetchStats } from './api.ts';
import { createBarChart } from './barchart.ts';
import { h } from './dom.ts';
import { emptyBox, errorBox, spinner } from './feed.ts';
import { formatCount, formatDay } from './format.ts';
import { createHeatmap } from './heatmap.ts';
import type { View } from './timeline.ts';

type Range = 'all' | 'recent5' | 'year';

const RANGES: readonly (readonly [Range, string])[] = [['all', 'すべて'], ['recent5', '直近5年'], ['year', '年を選択']];

const pct = (n: number, total: number): string => (total > 0 ? `${Math.round((n / total) * 100)}%` : '-');

type Tile = { readonly label: string; readonly value: string; readonly sub?: string; readonly wide?: boolean; readonly key: string };

const tilesOf = (s: StatsSummary): readonly Tile[] => {
  const t = s.totals;
  const sub = (n: number): { sub: string } => ({ sub: pct(n, t.tweets) });
  return [
    { key: 'tweets', label: 'ツイート', value: formatCount(t.tweets) },
    { key: 'original', label: 'オリジナル', value: formatCount(t.original), ...sub(t.original) },
    { key: 'replies', label: 'リプライ', value: formatCount(t.replies), ...sub(t.replies) },
    { key: 'retweets', label: 'RT', value: formatCount(t.retweets), ...sub(t.retweets) },
    { key: 'media', label: 'メディア付き', value: formatCount(t.withMedia), ...sub(t.withMedia) },
    { key: 'deleted', label: '削除済み', value: formatCount(t.deleted) },
    { key: 'removed', label: '消失', value: formatCount(t.removed) },
    { key: 'likes', label: 'いいね', value: formatCount(t.likes) },
    { key: 'dm', label: 'DM', value: `${formatCount(t.dmConversations)} 会話`, sub: `${formatCount(t.dmMessages)} メッセージ` },
    { key: 'period', label: '期間', value: s.first && s.last ? `${formatDay(s.first)} 〜 ${formatDay(s.last)}` : '-', wide: true },
  ];
};

const renderTiles = (s: StatsSummary): HTMLElement =>
  h('div', { class: 'stat-tiles' }, tilesOf(s).map((t) =>
    h('div', { class: `stat-tile${t.wide ? ' wide' : ''}`, 'data-stat': t.key },
      h('div', { class: 'stat-label' }, t.label),
      h('div', { class: 'stat-value' }, t.value),
      t.sub ? h('div', { class: 'stat-sub' }, t.sub) : null)));

const monthsFor = (s: StatsSummary, range: Range, year: number): readonly MonthlyStats[] =>
  range === 'recent5' ? s.monthly.slice(-60)
    : range === 'year' ? s.monthly.filter((m) => m.month.startsWith(`${year}-`))
    : s.monthly;

export const createStats = (scope: Scope): View => {
  const body = h('div', { class: 'stats-body' });
  const el = h('section', { class: 'view view-stats' }, h('div', { class: 'subhead' }, h('span', null, '統計'), scope.username ? h('span', { class: 'muted' }, `@${scope.username}`) : null), body);
  let alive = true;
  let chart: ReturnType<typeof createBarChart> | null = null;
  let heat: ReturnType<typeof createHeatmap> | null = null;

  const card = (title: string, ...children: (Node | null)[]): HTMLElement =>
    h('section', { class: 'stat-card' }, h('h2', { class: 'stat-title' }, title), children);

  const build = (s: StatsSummary): void => {
    chart?.destroy();
    heat?.destroy();
    if (s.totals.tweets === 0 || s.monthly.length === 0) {
      chart = null;
      heat = null;
      body.replaceChildren(renderTiles(s), emptyBox('ツイートがありません'));
      return;
    }
    const latestYear = s.years[s.years.length - 1] ?? Number(s.monthly[s.monthly.length - 1]?.month.slice(0, 4));
    let range: Range = 'all';
    let year = latestYear;

    const c = createBarChart(scope.account);
    chart = c;
    const buttons = RANGES.map(([r, label]) => h('button', { type: 'button', class: 'range-btn', 'data-range': r, 'aria-pressed': String(r === range), onclick: () => pick(r) }, label));
    const yearSel = h('select', { class: 'chart-year', 'aria-label': '年', hidden: true }, [...s.years].reverse().map((y) => h('option', { value: y }, `${y}年`)));
    yearSel.value = String(year);
    yearSel.addEventListener('change', () => {
      year = Number(yearSel.value);
      c.setMonths(monthsFor(s, range, year));
    });
    function pick(r: Range): void {
      range = r;
      buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(RANGES[i]?.[0] === r)));
      yearSel.hidden = r !== 'year';
      c.setMonths(monthsFor(s, range, year));
    }
    c.setMonths(monthsFor(s, range, year));

    const hm = createHeatmap({ years: s.years, account: scope.account, load: (y) => fetchDaily(scope.account, y) });
    heat = hm;

    body.replaceChildren(
      renderTiles(s),
      card('月別ツイート数', h('div', { class: 'chart-ctl' }, h('div', { class: 'range-seg', role: 'group', 'aria-label': '表示期間' }, buttons), yearSel), c.el),
      card('日別カレンダー', hm.el));
  };

  const load = (): void => {
    body.replaceChildren(spinner());
    fetchStats(scope.account).then((s) => {
      if (alive) build(s);
    }).catch((e: unknown) => {
      if (!alive) return;
      console.error('[stats] load failed', e);
      body.replaceChildren(errorBox(`統計を取得できませんでした: ${e instanceof Error ? e.message : String(e)}`, load));
    });
  };
  load();

  return {
    el,
    destroy: () => {
      alive = false;
      chart?.destroy();
      heat?.destroy();
    },
  };
};
