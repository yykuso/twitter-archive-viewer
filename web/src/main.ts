import type { Meta } from '../../src/shared/types.ts';
import { createAdmin } from './admin.ts';
import { fetchMeta } from './api.ts';
import { createDetail } from './detail.ts';
import { createDmList, createDmThread } from './dm.ts';
import { h } from './dom.ts';
import { errorBox, noDataBox } from './feed.ts';
import { setDisplayTimeZone } from './format.ts';
import { createLikes, type LikesView } from './likes.ts';
import { likesHash, parseHash, timelineHash, type Route } from './route.ts';
import { createTimeline, type TimelineView, type View } from './timeline.ts';

type Mounted =
  | { readonly kind: 'timeline'; readonly view: TimelineView; readonly key: string }
  | { readonly kind: 'likes'; readonly view: LikesView; readonly key: string }
  | { readonly kind: 'other'; readonly view: View };

/** 画面から離れても DOM と状態を保持しておくビュー (戻ったときにスクロール位置を復元する) */
type Parked =
  | { readonly kind: 'timeline'; readonly view: TimelineView; readonly key: string; readonly scrollY: number }
  | { readonly kind: 'likes'; readonly view: LikesView; readonly key: string; readonly scrollY: number };

const NAV: readonly (readonly [string, string, Route['kind'][]])[] = [
  ['#/', 'ツイート', ['timeline', 'tweet']],
  ['#/likes', 'いいね', ['likes']],
  ['#/dm', 'DM', ['dmList', 'dm']],
];

const DEFAULT_TITLE = 'Twitter Archive';

const titleOf = (meta: Meta): string =>
  meta.account ? meta.account.displayName || `@${meta.account.username}` : DEFAULT_TITLE;

const routeKey = (route: Route): string | null =>
  route.kind === 'timeline' ? timelineHash(route.query) : route.kind === 'likes' ? likesHash(route.q) : null;

const start = async (): Promise<void> => {
  const root = document.getElementById('app');
  if (!root) throw new Error('#app が見つかりません');
  history.scrollRestoration = 'manual';

  const title = h('a', { class: 'site-title', href: '#/' }, DEFAULT_TITLE);
  const navLinks = NAV.map(([href, label]) => h('a', { class: 'nav-link', href }, label));
  const adminLink = h('a', { class: 'nav-link nav-admin', href: '#/admin', 'aria-label': '管理', title: '管理' },
    h('span', { class: 'nav-ico', 'aria-hidden': 'true' }, '⚙'), h('span', { class: 'nav-txt' }, '管理'));
  const header = h('header', { class: 'app-header' }, h('div', { class: 'app-header-in' }, title, h('nav', null, navLinks, adminLink)));
  const banner = h('div', { class: 'banner' });
  const main = h('main', { class: 'app-main' });
  root.replaceChildren(header, banner, main);

  let username: string | null = null;
  let empty = false;
  let mounted: Mounted | null = null;
  let parked: Parked | null = null;

  const dropParked = (): void => {
    parked?.view.destroy();
    parked = null;
  };

  const refreshMeta = async (): Promise<void> => {
    try {
      const meta = await fetchMeta();
      setDisplayTimeZone(meta.timezone);
      username = meta.account?.username ?? null;
      empty = meta.account === null;
      title.textContent = titleOf(meta);
      document.title = meta.account ? `${title.textContent} - アーカイブ` : DEFAULT_TITLE;
      banner.replaceChildren();
    } catch (e) {
      console.error('[main] meta load failed', e);
      banner.replaceChildren(h('div', { class: 'state state-error', role: 'alert' }, `アカウント情報を取得できませんでした: ${e instanceof Error ? e.message : String(e)}`));
    }
    // データが変わった可能性があるので、保持していたビューは破棄する
    dropParked();
  };

  const mountNew = (route: Route): Mounted => {
    switch (route.kind) {
      case 'admin': return { kind: 'other', view: createAdmin({ onChanged: refreshMeta }) };
      case 'timeline': return { kind: 'timeline', view: createTimeline(username, route.query), key: timelineHash(route.query) };
      case 'likes': return { kind: 'likes', view: createLikes(route.q), key: likesHash(route.q) };
      case 'tweet': return { kind: 'other', view: createDetail(username, route.id) };
      case 'dmList': return { kind: 'other', view: createDmList() };
      case 'dm': return { kind: 'other', view: createDmThread(route.id) };
    }
  };

  const render = (): void => {
    const route = parseHash(location.hash);
    NAV.forEach(([, , kinds], i) => navLinks[i]?.classList.toggle('active', kinds.includes(route.kind)));
    adminLink.classList.toggle('active', route.kind === 'admin');

    if (mounted?.kind === 'timeline' && route.kind === 'timeline') {
      mounted = { ...mounted, key: timelineHash(route.query) };
      mounted.view.update(route.query);
      return;
    }
    if (mounted?.kind === 'likes' && route.kind === 'likes') {
      mounted = { ...mounted, key: likesHash(route.q) };
      mounted.view.update(route.q);
      return;
    }
    if (mounted?.kind === 'other' && route.kind === 'admin' && mounted.view.el.classList.contains('view-admin')) return;

    // 離れるビュー: タイムライン/いいねは保持、それ以外は破棄
    const leavingScroll = window.scrollY;
    if (mounted?.kind === 'timeline' || mounted?.kind === 'likes') {
      dropParked();
      parked = { ...mounted, scrollY: leavingScroll } as Parked;
    } else {
      mounted?.view.destroy();
    }
    mounted = null;

    const needsData = route.kind !== 'admin';
    const key = routeKey(route);
    if (needsData && empty) {
      mounted = { kind: 'other', view: { el: noDataBox(), destroy: () => undefined } };
      main.replaceChildren(mounted.view.el);
      window.scrollTo(0, 0);
      return;
    }
    if (parked && key !== null && parked.kind === route.kind && parked.key === key) {
      const p = parked;
      parked = null;
      mounted = p.kind === 'timeline' ? { kind: 'timeline', view: p.view, key: p.key } : { kind: 'likes', view: p.view, key: p.key };
      main.replaceChildren(p.view.el);
      window.scrollTo(0, p.scrollY);
      return;
    }
    mounted = mountNew(route);
    main.replaceChildren(mounted.view.el);
    window.scrollTo(0, 0);
  };

  await refreshMeta();
  window.addEventListener('hashchange', render);
  render();
};

start().catch((e: unknown) => {
  console.error('[main] fatal', e);
  const root = document.getElementById('app');
  root?.replaceChildren(errorBox(`起動に失敗しました: ${e instanceof Error ? e.message : String(e)}`, () => location.reload()));
});
