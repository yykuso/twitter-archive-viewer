import type { Like } from '../../src/shared/types.ts';
import { fetchLikes } from './api.ts';
import { h, linkify, termsOf } from './dom.ts';
import { createFeed, type Feed } from './feed.ts';
import { likesHash } from './route.ts';
import { removedBadge } from './tweet.ts';
import type { View } from './timeline.ts';
import type { Scope } from './account.ts';

export type LikesView = View & { readonly update: (q: string) => void };

export const createLikes = (scope: Scope, initialQ: string): LikesView => {
  let q = initialQ;
  let feed: Feed | null = null;
  const host = h('div', { class: 'feed-host' });
  const search = h('input', { type: 'search', class: 'search', placeholder: 'いいねを検索 (Enter)', 'aria-label': 'いいねを検索', enterkeyhint: 'search', autocomplete: 'off' });
  search.value = initialQ;

  const navigate = (): void => {
    const hash = likesHash(search.value.trim(), scope.account);
    if (location.hash !== hash) location.hash = hash;
  };
  // 入力中は検索しない (IME 変換中の Enter も無視)。Enter で確定、または空にしたときだけ検索する
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) navigate(); });
  search.addEventListener('input', () => { if (search.value === '') navigate(); });

  const mount = (query: string): void => {
    feed?.destroy();
    const terms = termsOf(query);
    feed = createFeed<Like>({
      mode: 'scroll',
      emptyText: '該当なし',
      load: (cursor) => fetchLikes(scope.account, query || undefined, cursor),
      render: (l) => h('article', { class: 'tweet like' },
        h('p', { class: 'tw-text' }, linkify(l.text, terms)),
        h('div', { class: 'tw-head' },
          removedBadge(l.removedAt),
          h('a', { class: 'tw-ext', href: l.url, target: '_blank', rel: 'noopener noreferrer' }, '元のツイートを開く ↗'))),
    });
    host.replaceChildren(feed.el);
  };
  mount(initialQ);

  return {
    el: h('section', { class: 'view view-likes' }, h('div', { class: 'toolbar' }, h('div', { class: 'search-row' }, search)), host),
    update: (next) => {
      if (next === q) return;
      q = next;
      if (document.activeElement !== search) search.value = next;
      mount(next);
      window.scrollTo(0, 0);
    },
    destroy: () => feed?.destroy(),
  };
};
