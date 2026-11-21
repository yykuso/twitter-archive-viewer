import type { AccountSummary, Meta } from '../../src/shared/types.ts';
import { forgetStoredAccount, loadStoredAccount, storeAccount, type Scope } from './account.ts';
import { createAdmin } from './admin.ts';
import { ApiFailure, fetchAccounts, fetchMeta } from './api.ts';
import { createDetail } from './detail.ts';
import { createDmList, createDmThread } from './dm.ts';
import { h } from './dom.ts';
import { errorBox, noDataBox, spinner } from './feed.ts';
import { setDisplayTimeZone } from './format.ts';
import { createLikes, type LikesView } from './likes.ts';
import {
  adminHash, dmListHash, likesHash, parseHash, statsHash, switchTargetHash, timelineHash, withAccountParam, type Route,
} from './route.ts';
import { createStats } from './stats.ts';
import { avatar, createSwitcher } from './switcher.ts';
import { createTimeline, type TimelineView, type View } from './timeline.ts';

type Mounted =
  | { readonly kind: 'timeline'; readonly view: TimelineView; readonly key: string }
  | { readonly kind: 'likes'; readonly view: LikesView; readonly key: string }
  | { readonly kind: 'other'; readonly view: View };

/** 画面から離れても DOM と状態を保持しておくビュー (戻ったときにスクロール位置を復元する) */
type Parked =
  | { readonly kind: 'timeline'; readonly view: TimelineView; readonly key: string; readonly scrollY: number }
  | { readonly kind: 'likes'; readonly view: LikesView; readonly key: string; readonly scrollY: number };

type NavItem = { readonly label: string; readonly href: (account: string | undefined) => string; readonly kinds: readonly Route['kind'][] };

const NAV: readonly NavItem[] = [
  { label: 'ツイート', href: (a) => timelineHash({}, a), kinds: ['timeline', 'tweet'] },
  { label: 'いいね', href: (a) => likesHash('', a), kinds: ['likes'] },
  { label: 'DM', href: dmListHash, kinds: ['dmList', 'dm'] },
  { label: '統計', href: statsHash, kinds: ['stats'] },
];

const DEFAULT_TITLE = 'Twitter Archive';

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const titleOf = (meta: Meta): string =>
  meta.account ? meta.account.displayName || `@${meta.account.username}` : DEFAULT_TITLE;

const routeKey = (route: Route, account: string | undefined): string | null =>
  route.kind === 'timeline' ? timelineHash(route.query, account) : route.kind === 'likes' ? likesHash(route.q, account) : null;

const start = async (): Promise<void> => {
  const root = document.getElementById('app');
  if (!root) throw new Error('#app が見つかりません');
  history.scrollRestoration = 'manual';

  const title = h('a', { class: 'site-title', href: '#/' }, DEFAULT_TITLE);
  const switcher = createSwitcher((id) => switchAccount(id));
  switcher.el.hidden = true;
  const navLinks = NAV.map((n) => h('a', { class: 'nav-link' }, n.label));
  const adminLink = h('a', { class: 'nav-link nav-admin', 'aria-label': '管理', title: '管理' },
    h('span', { class: 'nav-ico', 'aria-hidden': 'true' }, '⚙'), h('span', { class: 'nav-txt' }, '管理'));
  const header = h('header', { class: 'app-header' },
    h('div', { class: 'app-header-in' }, h('div', { class: 'brand' }, title, switcher.el), h('nav', null, navLinks, adminLink)));
  const errorHost = h('div', { class: 'banner' });
  const noticeHost = h('div', { class: 'banner' });
  const main = h('main', { class: 'app-main' });
  root.replaceChildren(header, errorHost, noticeHost, main);

  /** 現在の対象アカウント (URL の account、無ければ localStorage、無ければ undefined = サーバー既定) */
  let account: string | undefined;
  let loaded = false;
  let username: string | null = null;
  let currentId: string | null = null;
  let empty = false;
  let mounted: Mounted | null = null;
  let parked: Parked | null = null;
  let notice: string | null = null;
  let seq = 0;

  const scope = (): Scope => ({ account, username });

  const dropParked = (): void => {
    parked?.view.destroy();
    parked = null;
  };

  const showNotice = (): void => {
    noticeHost.replaceChildren(...(notice === null ? [] : [h('div', { class: 'state state-notice', role: 'status' }, notice)]));
  };

  /** meta を取得する。account が 404 (削除済み) なら忘れて既定アカウントで取り直す */
  const loadMeta = async (): Promise<Meta> => {
    try {
      return await fetchMeta(account);
    } catch (e) {
      if (account !== undefined && e instanceof ApiFailure && e.status === 404) {
        console.warn(`[main] account ${account} not found; falling back to default`);
        forgetStoredAccount(account);
        account = undefined;
        history.replaceState(null, '', withAccountParam(location.hash, undefined));
        notice = '選択していたアカウントが見つからないため、既定のアカウントを表示しています';
        return await loadMeta();
      }
      throw e;
    }
  };

  const loadAccounts = async (): Promise<readonly AccountSummary[]> => {
    try {
      return await fetchAccounts();
    } catch (e) {
      console.error('[main] accounts load failed', e);
      errorHost.append(h('div', { class: 'state state-error', role: 'alert' }, `アカウント一覧を取得できませんでした: ${messageOf(e)}`));
      return [];
    }
  };

  const refreshMeta = async (): Promise<void> => {
    errorHost.replaceChildren();
    let accounts: readonly AccountSummary[] = [];
    try {
      const [meta, list] = await Promise.all([loadMeta(), loadAccounts()]);
      accounts = list;
      // 未指定 (サーバー既定) のままだと、取り込みで既定アカウントが変わったときに
      // ヘッダー表示と各 API の取得先がずれる。解決したアカウントを固定する。
      if (account === undefined && meta.account !== null) {
        account = meta.account.id;
        storeAccount(account);
        history.replaceState(null, '', withAccountParam(location.hash, account));
      }
      setDisplayTimeZone(meta.timezone);
      username = meta.account?.username ?? null;
      currentId = meta.account?.id ?? null;
      empty = meta.account === null;
      const name = titleOf(meta);
      title.replaceChildren(
        ...(meta.account ? [avatar(meta.profile.avatarUrl, meta.account.username, 'sm')] : []),
        h('span', { class: 'site-title-text' }, name),
      );
      document.title = meta.account ? `${name} - アーカイブ` : DEFAULT_TITLE;
      const multi = accounts.length > 1 && meta.account !== null;
      title.hidden = multi;
      switcher.el.hidden = !multi;
      switcher.update({
        accounts,
        current: meta.account ? { ...meta.account, avatarUrl: meta.profile.avatarUrl } : null,
      });
    } catch (e) {
      console.error('[main] meta load failed', e);
      errorHost.append(h('div', { class: 'state state-error', role: 'alert' }, `アカウント情報を取得できませんでした: ${messageOf(e)}`));
    }
    showNotice();
    // データが変わった可能性があるので、保持していたビューは破棄する
    dropParked();
  };

  const switchAccount = (id: string): void => {
    storeAccount(id);
    if (id === currentId) return;
    const target = switchTargetHash(parseHash(location.hash).route, id);
    if (location.hash === target) return;
    location.hash = target;
  };

  const mountNew = (route: Route): Mounted => {
    const sc = scope();
    switch (route.kind) {
      case 'admin': return { kind: 'other', view: createAdmin({ account, onChanged: refreshMeta }) };
      case 'timeline': return { kind: 'timeline', view: createTimeline(sc, route.query), key: timelineHash(route.query, account) };
      case 'likes': return { kind: 'likes', view: createLikes(sc, route.q), key: likesHash(route.q, account) };
      case 'tweet': return { kind: 'other', view: createDetail(sc, route.id) };
      case 'dmList': return { kind: 'other', view: createDmList(sc) };
      case 'dm': return { kind: 'other', view: createDmThread(sc, route.id) };
      case 'stats': return { kind: 'other', view: createStats(sc) };
    }
  };

  const render = (): void => {
    const { route } = parseHash(location.hash);
    NAV.forEach((n, i) => {
      const a = navLinks[i];
      if (!a) return;
      a.setAttribute('href', n.href(account));
      a.classList.toggle('active', n.kinds.includes(route.kind));
    });
    adminLink.setAttribute('href', adminHash(account));
    adminLink.classList.toggle('active', route.kind === 'admin');
    title.setAttribute('href', timelineHash({}, account));

    if (mounted?.kind === 'timeline' && route.kind === 'timeline') {
      mounted = { ...mounted, key: timelineHash(route.query, account) };
      mounted.view.update(route.query);
      return;
    }
    if (mounted?.kind === 'likes' && route.kind === 'likes') {
      mounted = { ...mounted, key: likesHash(route.q, account) };
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
    const key = routeKey(route, account);
    if (needsData && empty) {
      mounted = { kind: 'other', view: { el: noDataBox(adminHash(account)), destroy: () => undefined } };
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

  /** ハッシュ変更: アカウントが変わっていれば meta を取り直し、表示中のビューを破棄してから描画する */
  const onHash = async (): Promise<void> => {
    const mine = ++seq;
    let next = parseHash(location.hash).account;
    if (next === undefined) {
      next = loadStoredAccount();
      if (next !== undefined) history.replaceState(null, '', withAccountParam(location.hash, next));
    }
    if (!loaded || next !== account) {
      account = next;
      notice = null;
      mounted?.view.destroy();
      mounted = null;
      dropParked();
      main.replaceChildren(spinner());
      await refreshMeta();
      loaded = true;
      if (mine !== seq) return;
    }
    render();
  };

  window.addEventListener('hashchange', () => {
    void onHash().catch((e: unknown) => {
      console.error('[main] navigation failed', e);
      main.replaceChildren(errorBox(`画面を表示できませんでした: ${messageOf(e)}`, () => void onHash()));
    });
  });
  await onHash();
};

start().catch((e: unknown) => {
  console.error('[main] fatal', e);
  const root = document.getElementById('app');
  root?.replaceChildren(errorBox(`起動に失敗しました: ${e instanceof Error ? e.message : String(e)}`, () => location.reload()));
});
