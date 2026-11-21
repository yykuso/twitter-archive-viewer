// 統計グラフ共通: ツールチップ・目盛り。SVG の data 属性やラベルには常に Text 経由で挿入する。
import { h, type Child } from './dom.ts';

export type Tooltip = {
  readonly el: HTMLElement;
  /** svg 要素にホバー/タップ/クリックの挙動を付ける。href はクリック (タッチでは 2 本目のリンク) の遷移先 */
  readonly attach: (target: Element, anchor: Element, lines: readonly Child[], href: string, linkLabel: string) => void;
  readonly hide: () => void;
  readonly destroy: () => void;
};

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/**
 * host (position: relative) の中に出すツールチップ。
 * マウス: ホバーで表示、クリックで遷移。タッチ: タップで表示 (リンク付き)、外側タップで閉じる。
 */
export const createTooltip = (host: HTMLElement): Tooltip => {
  const el = h('div', { class: 'chart-tip', role: 'status', hidden: true });
  let sticky = false;

  const hide = (): void => {
    sticky = false;
    el.hidden = true;
    el.classList.remove('sticky');
  };

  const show = (anchor: Element, lines: readonly Child[], link: Node | null, isSticky: boolean): void => {
    sticky = isSticky;
    el.replaceChildren(...lines.map((l) => h('div', { class: 'tip-line' }, l)), ...(link ? [link] : []));
    el.classList.toggle('sticky', isSticky);
    el.hidden = false;
    const hr = host.getBoundingClientRect();
    const ar = anchor.getBoundingClientRect();
    const w = el.offsetWidth;
    const hgt = el.offsetHeight;
    const left = clamp(ar.left - hr.left + ar.width / 2 - w / 2, 4, Math.max(4, hr.width - w - 4));
    const above = ar.top - hr.top - hgt - 6;
    el.style.left = `${left}px`;
    el.style.top = `${above >= 0 ? above : ar.bottom - hr.top + 6}px`;
  };

  const onDocPointer = (e: Event): void => {
    if (sticky && e.target instanceof Node && !el.contains(e.target)) hide();
  };
  document.addEventListener('pointerdown', onDocPointer, true);

  const attach: Tooltip['attach'] = (target, anchor, lines, href, linkLabel) => {
    let lastType = 'mouse';
    target.addEventListener('pointerenter', (e) => {
      if ((e as PointerEvent).pointerType !== 'touch') show(anchor, lines, null, false);
    });
    target.addEventListener('pointerleave', (e) => {
      if ((e as PointerEvent).pointerType !== 'touch') hide();
    });
    target.addEventListener('pointerdown', (e) => {
      lastType = (e as PointerEvent).pointerType;
      if (lastType === 'touch') show(anchor, lines, h('a', { class: 'tip-link', href }, linkLabel), true);
    });
    target.addEventListener('click', () => {
      if (lastType === 'touch') return;
      location.hash = href;
    });
  };

  return { el, attach, hide, destroy: () => document.removeEventListener('pointerdown', onDocPointer, true) };
};

/** 0 から始まる見やすい目盛り (整数)。max が 0 なら [0, 1] */
export const niceTicks = (max: number, target = 4): readonly number[] => {
  if (max <= 0) return [0, 1];
  const raw = max / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = Math.max(1, (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag);
  const top = Math.ceil(max / step) * step;
  return Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
};

/** 要素の幅 (px) を監視する。幅が変わったときだけ呼ぶ */
export const observeWidth = (el: HTMLElement, onWidth: (w: number) => void): (() => void) => {
  let last = -1;
  const ro = new ResizeObserver(() => {
    const w = Math.floor(el.clientWidth);
    if (w === last) return;
    last = w;
    onWidth(w);
  });
  ro.observe(el);
  return () => ro.disconnect();
};
