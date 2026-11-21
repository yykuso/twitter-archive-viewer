import type { Tweet } from '../../src/shared/types.ts';
import { fetchTweetDetail } from './api.ts';
import { h } from './dom.ts';
import { errorBox, spinner } from './feed.ts';
import type { View } from './timeline.ts';
import { renderTweet } from './tweet.ts';

export const createDetail = (username: string | null, id: string): View => {
  const body = h('div', { class: 'detail-body' });
  const el = h('section', { class: 'view view-detail' },
    h('div', { class: 'subhead' }, h('button', { type: 'button', class: 'btn', onclick: () => history.back() }, '← 戻る'), h('span', null, 'ツイート')),
    body);
  const ctx = { username, terms: [] as string[] };
  let alive = true;

  const load = (): void => {
    body.replaceChildren(spinner());
    fetchTweetDetail(id).then((d) => {
      if (!alive) return;
      const card = (t: Tweet, role: 'parent' | 'main' | 'reply'): HTMLElement => renderTweet(t, ctx, { large: role === 'main', role });
      body.replaceChildren(
        d.parent ? card(d.parent, 'parent') : '',
        card(d.tweet, 'main'),
        d.replies.length > 0 ? h('h2', { class: 'section-title' }, `返信 (${d.replies.length})`) : '',
        ...d.replies.map((r) => card(r, 'reply')));
    }).catch((e: unknown) => {
      if (!alive) return;
      console.error(`[detail] load failed for tweet ${id}`, e);
      body.replaceChildren(errorBox(e instanceof Error ? e.message : String(e), load));
    });
  };
  load();
  return { el, destroy: () => { alive = false; } };
};
