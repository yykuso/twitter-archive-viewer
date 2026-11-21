import type { AccountSummary } from '../../src/shared/types.ts';
import { h } from './dom.ts';
import { formatCount, formatDay } from './format.ts';

export type SwitcherState = {
  readonly accounts: readonly AccountSummary[];
  /** 表示中のアカウント */
  readonly current: { readonly id: string; readonly username: string; readonly displayName: string; readonly avatarUrl: string | null } | null;
};

export type Switcher = {
  readonly el: HTMLElement;
  readonly update: (s: SwitcherState) => void;
  readonly destroy: () => void;
};

/** アバター画像。無い・読み込めない場合は頭文字の丸 */
export const avatar = (url: string | null, name: string, size: 'sm' | 'md'): HTMLElement => {
  const initial = h('span', { class: `avatar avatar-${size} avatar-ph`, 'aria-hidden': 'true' }, [...name.replace(/^@/, '')][0]?.toUpperCase() ?? '?');
  if (url === null) return initial;
  const img = h('img', { class: `avatar avatar-${size}`, src: url, alt: '', width: size === 'sm' ? 24 : 36, height: size === 'sm' ? 24 : 36, decoding: 'async' });
  img.addEventListener('error', () => {
    console.warn(`[switcher] avatar load failed: ${url}`);
    img.replaceWith(initial);
  });
  return img;
};

/** ヘッダーのアカウント切り替え。メニューは Esc・外側クリック・フォーカス移動で閉じる */
export const createSwitcher = (onPick: (id: string) => void): Switcher => {
  let state: SwitcherState = { accounts: [], current: null };
  let open = false;

  const btn = h('button', { type: 'button', class: 'acct-btn', 'aria-haspopup': 'true', 'aria-expanded': 'false', 'aria-label': 'アカウントを切り替える' });
  const menu = h('div', { class: 'acct-menu', role: 'menu', 'aria-label': 'アカウント', hidden: true });
  const el = h('div', { class: 'acct' }, btn, menu);

  const items = (): HTMLElement[] => [...menu.querySelectorAll<HTMLElement>('[role=menuitemradio]')];

  const onDocPointer = (e: Event): void => {
    if (e.target instanceof Node && !el.contains(e.target)) setOpen(false, false);
  };

  function setOpen(next: boolean, focusButton: boolean): void {
    if (open === next) return;
    open = next;
    btn.setAttribute('aria-expanded', String(open));
    menu.hidden = !open;
    if (open) {
      document.addEventListener('pointerdown', onDocPointer);
      const list = items();
      (list.find((i) => i.getAttribute('aria-checked') === 'true') ?? list[0])?.focus();
    } else {
      document.removeEventListener('pointerdown', onDocPointer);
      if (focusButton) btn.focus();
    }
  }

  const render = (): void => {
    const c = state.current;
    btn.replaceChildren(
      ...(c ? [avatar(c.avatarUrl, c.username, 'sm')] : []),
      h('span', { class: 'acct-name' }, c ? `@${c.username}` : 'アカウント'),
      h('span', { class: 'acct-caret', 'aria-hidden': 'true' }, '▾'));
    menu.replaceChildren(...state.accounts.map((a) => {
      const checked = c?.id === a.id;
      const meta = [`ツイート ${formatCount(a.tweetCount)}`, a.lastImportedAt ? `取り込み ${formatDay(a.lastImportedAt)}` : null].filter((v) => v !== null).join(' ・ ');
      return h('button', { type: 'button', class: `acct-item${checked ? ' current' : ''}`, role: 'menuitemradio', 'aria-checked': String(checked), 'data-id': a.id, onclick: () => {
        setOpen(false, true);
        onPick(a.id);
      } },
      avatar(a.avatarUrl, a.username, 'md'),
      h('span', { class: 'acct-item-text' },
        h('span', { class: 'acct-dn' }, a.displayName || `@${a.username}`),
        h('span', { class: 'acct-un' }, `@${a.username}`),
        h('span', { class: 'acct-meta' }, meta)),
      h('span', { class: 'acct-check', 'aria-hidden': 'true' }, checked ? '✓' : ''));
    }));
  };

  btn.addEventListener('click', () => setOpen(!open, false));
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && !open) {
      e.preventDefault();
      setOpen(true, false);
    }
  });
  el.addEventListener('keydown', (e) => {
    if (!open) return;
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false, true);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      list[(i + 1) % list.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      list[(i - 1 + list.length) % list.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      list[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      list[list.length - 1]?.focus();
    }
  });
  el.addEventListener('focusout', (e) => {
    if (open && e.relatedTarget instanceof Node && !el.contains(e.relatedTarget)) setOpen(false, false);
  });

  render();
  return {
    el,
    update: (s) => {
      state = s;
      render();
      if (open) setOpen(false, false);
    },
    destroy: () => document.removeEventListener('pointerdown', onDocPointer),
  };
};
