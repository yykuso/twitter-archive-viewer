import type { Page } from '../../src/shared/types.ts';
import { h } from './dom.ts';

export type Feed = { readonly el: HTMLElement; readonly destroy: () => void };

export type FeedOptions<T> = {
  readonly load: (cursor: string | null) => Promise<Page<T>>;
  readonly render: (item: T) => Node;
  readonly emptyText: string;
  /** 'scroll' = 無限スクロール, 'button' = 「もっと見る」ボタン */
  readonly mode: 'scroll' | 'button';
};

export const spinner = (): HTMLElement => h('div', { class: 'spinner', role: 'status', 'aria-label': '読み込み中' });

export const errorBox = (message: string, onRetry: () => void): HTMLElement =>
  h('div', { class: 'state state-error', role: 'alert' },
    h('p', null, message),
    h('button', { type: 'button', class: 'btn', onclick: onRetry }, '再試行'));

export const emptyBox = (text: string): HTMLElement => h('div', { class: 'state state-empty' }, text);

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** ページング付きリスト。内部状態は閉包に閉じ込める */
export const createFeed = <T>(opts: FeedOptions<T>): Feed => {
  const list = h('div', { class: 'feed-list' });
  const status = h('div', { class: 'feed-status' });
  const sentinel = h('div', { class: 'feed-sentinel' });
  const el = h('div', { class: 'feed' }, list, status, sentinel);

  let alive = true;
  let loading = false;
  let done = false;
  let failed = false;
  let cursor: string | null = null;
  let count = 0;
  let observer: IntersectionObserver | null = null;

  const setStatus = (...nodes: Node[]): void => {
    status.replaceChildren(...nodes);
  };

  const nearBottom = (): boolean => sentinel.getBoundingClientRect().top < window.innerHeight + 700;

  const loadMore = async (): Promise<void> => {
    if (!alive || loading || done || failed) return;
    loading = true;
    setStatus(spinner());
    try {
      const page = await opts.load(cursor);
      if (!alive) return;
      for (const item of page.items) list.appendChild(opts.render(item));
      count += page.items.length;
      cursor = page.nextCursor;
      done = page.nextCursor === null;
      loading = false;
      if (count === 0) {
        setStatus(emptyBox(opts.emptyText));
      } else if (done) {
        setStatus();
      } else if (opts.mode === 'button') {
        setStatus(h('button', { type: 'button', class: 'btn btn-wide', onclick: () => void loadMore() }, 'もっと見る'));
      } else {
        setStatus();
        if (nearBottom()) void loadMore();
      }
    } catch (e) {
      if (!alive) return;
      console.error('[feed] load failed', e);
      failed = true;
      loading = false;
      setStatus(errorBox(messageOf(e), () => {
        failed = false;
        void loadMore();
      }));
    }
  };

  if (opts.mode === 'scroll') {
    observer = new IntersectionObserver((entries) => {
      if (entries.some((en) => en.isIntersecting)) void loadMore();
    }, { rootMargin: '700px 0px' });
    observer.observe(sentinel);
  }
  void loadMore();

  return {
    el,
    destroy: () => {
      alive = false;
      observer?.disconnect();
    },
  };
};

/** 未取り込み時の空状態 */
export const noDataBox = (): HTMLElement =>
  h('div', { class: 'state state-empty state-nodata' },
    h('p', null, 'まだデータが取り込まれていません'),
    h('a', { class: 'btn btn-primary', href: '#/admin' }, '取り込み画面へ'));
