import type { MonthCount, RemovedFilter, Tweet, TweetQuery, TweetType } from '../../src/shared/types.ts';
import { fetchCalendar, fetchTweets } from './api.ts';
import { debounce, h, termsOf } from './dom.ts';
import { createFeed, type Feed } from './feed.ts';
import { monthRange } from './format.ts';
import { sameQuery, timelineHash } from './route.ts';
import { renderTweet } from './tweet.ts';

export type View = {
  readonly el: HTMLElement;
  readonly destroy: () => void;
};

export type TimelineView = View & { readonly update: (q: TweetQuery) => void };

const TYPE_LABELS: readonly (readonly [TweetType, string])[] = [
  ['all', 'すべて'], ['original', 'ツイート'], ['reply', 'リプライ'], ['retweet', 'RT'],
];

const REMOVED_LABELS: readonly (readonly [RemovedFilter, string])[] = [
  ['include', 'すべて'], ['exclude', '現存のみ'], ['only', '消失・削除のみ'],
];

const buildMonthSelect = (months: readonly MonthCount[], onPick: (month: string) => void): HTMLSelectElement => {
  const byYear = new Map<string, MonthCount[]>();
  for (const m of [...months].sort((a, b) => b.month.localeCompare(a.month))) {
    const y = m.month.slice(0, 4);
    byYear.set(y, [...(byYear.get(y) ?? []), m]);
  }
  const select = h('select', { 'aria-label': '月へジャンプ', onchange: () => {
    if (select.value) onPick(select.value);
    select.value = '';
  } },
  h('option', { value: '' }, '月を選択…'),
  [...byYear].map(([year, list]) =>
    h('optgroup', { label: `${year}年` }, list.map((m) =>
      h('option', { value: m.month }, `${Number(m.month.slice(5, 7))}月 (${m.count.toLocaleString('ja-JP')})`)))));
  return select;
};

export const createTimeline = (username: string | null, initial: TweetQuery): TimelineView => {
  let current: TweetQuery = initial;
  let feed: Feed | null = null;

  const feedHost = h('div', { class: 'feed-host' });
  const search = h('input', { type: 'search', class: 'search', placeholder: 'ツイートを検索', 'aria-label': 'ツイートを検索', enterkeyhint: 'search', autocomplete: 'off' });
  const typeSel = h('select', { 'aria-label': '種類' }, TYPE_LABELS.map(([v, l]) => h('option', { value: v }, l)));
  const media = h('input', { type: 'checkbox' });
  const from = h('input', { type: 'date', 'aria-label': '期間(開始)' });
  const to = h('input', { type: 'date', 'aria-label': '期間(終了)' });
  const removedSel = h('select', { 'aria-label': '表示' }, REMOVED_LABELS.map(([v, l]) => h('option', { value: v }, l)));
  const order = h('select', { 'aria-label': '並び順' },
    h('option', { value: 'desc' }, '新しい順'), h('option', { value: 'asc' }, '古い順'));
  const monthHost = h('div', { class: 'month-host' });
  const filterBtn = h('button', { type: 'button', class: 'btn btn-filter', 'aria-expanded': 'false', 'aria-controls': 'filters' }, '絞り込み');

  const readQuery = (): TweetQuery => ({
    ...(search.value.trim() ? { q: search.value.trim() } : {}),
    ...(from.value ? { from: from.value } : {}),
    ...(to.value ? { to: to.value } : {}),
    ...(typeSel.value !== 'all' ? { type: typeSel.value as TweetType } : {}),
    ...(media.checked ? { media: '1' as const } : {}),
    ...(order.value === 'asc' ? { order: 'asc' as const } : {}),
    ...(removedSel.value === 'exclude' || removedSel.value === 'only' ? { removed: removedSel.value } : {}),
  });

  const navigate = (): void => {
    const hash = timelineHash(readQuery());
    if (location.hash === hash) return;
    location.hash = hash;
  };
  const navigateDebounced = debounce(navigate, 300);

  const syncControls = (q: TweetQuery): void => {
    if (document.activeElement !== search) search.value = q.q ?? '';
    typeSel.value = q.type ?? 'all';
    media.checked = q.media === '1';
    from.value = q.from ?? '';
    to.value = q.to ?? '';
    order.value = q.order ?? 'desc';
    removedSel.value = q.removed ?? 'include';
    const active = [q.from, q.to, q.type, q.media, q.order, q.removed].some((v) => v !== undefined);
    filterBtn.classList.toggle('has-active', active);
  };

  const mountFeed = (q: TweetQuery): void => {
    feed?.destroy();
    const terms = termsOf(q.q);
    const ctx = { username, terms };
    feed = createFeed<Tweet>({
      mode: 'scroll',
      emptyText: '該当なし',
      load: (cursor) => fetchTweets({ ...q, ...(cursor ? { cursor } : {}) }),
      render: (t) => renderTweet(t, ctx),
    });
    feedHost.replaceChildren(feed.el);
  };

  search.addEventListener('input', navigateDebounced);
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') navigate(); });
  for (const c of [typeSel, media, from, to, order, removedSel]) c.addEventListener('change', navigate);

  const panel = h('div', { class: 'filters', id: 'filters' },
    h('div', { class: 'f-row' }, h('label', null, '種類'), typeSel, h('label', { class: 'chk' }, media, 'メディアのみ')),
    h('div', { class: 'f-row' }, h('label', null, '期間'), from, h('span', null, '〜'), to),
    h('div', { class: 'f-row' }, h('label', null, '並び順'), order, monthHost),
    h('div', { class: 'f-row' }, h('label', null, '表示'), removedSel));
  filterBtn.addEventListener('click', () => {
    const open = panel.classList.toggle('open');
    filterBtn.setAttribute('aria-expanded', String(open));
  });

  const toolbar = h('div', { class: 'toolbar' }, h('div', { class: 'search-row' }, search, filterBtn), panel);
  const el = h('section', { class: 'view view-timeline' }, toolbar, feedHost);

  syncControls(initial);
  mountFeed(initial);

  fetchCalendar().then((months) => {
    monthHost.replaceChildren(buildMonthSelect(months, (month) => {
      const r = monthRange(month);
      if (!r) return;
      from.value = r.from;
      to.value = r.to;
      navigate();
    }));
  }).catch((e: unknown) => {
    console.error('[timeline] calendar load failed', e);
    monthHost.replaceChildren(h('span', { class: 'muted' }, '月一覧を取得できませんでした'));
  });

  return {
    el,
    update: (q) => {
      if (sameQuery(q, current)) return;
      current = q;
      syncControls(q);
      mountFeed(q);
      window.scrollTo(0, 0);
    },
    destroy: () => feed?.destroy(),
  };
};
