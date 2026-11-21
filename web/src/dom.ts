// 最小の DOM ヘルパ。data は常に textContent / Text ノード経由で挿入する。

export type Child = Node | string | number | null | undefined | false | readonly Child[];
export type AttrValue = string | number | boolean | null | undefined | EventListener;
export type Attrs = Readonly<Record<string, AttrValue>>;

const appendChildren = (parent: Node, children: readonly Child[]): void => {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) appendChildren(parent, c as readonly Child[]);
    else if (typeof c === 'string' || typeof c === 'number') parent.appendChild(document.createTextNode(String(c)));
    else if (c instanceof Node) parent.appendChild(c);
  }
};

export const h = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (typeof value === 'function') {
        el.addEventListener(key.startsWith('on') ? key.slice(2) : key, value);
      } else if (key === 'class') {
        el.className = String(value);
      } else if (value === true) {
        el.setAttribute(key, '');
      } else {
        el.setAttribute(key, String(value));
      }
    }
  }
  appendChildren(el, children);
  return el;
};

export const clear = (el: Element): void => {
  while (el.firstChild) el.removeChild(el.firstChild);
};

export const debounce = <A extends unknown[]>(fn: (...a: A) => void, ms: number): ((...a: A) => void) => {
  let t: number | undefined;
  return (...a: A) => {
    if (t !== undefined) window.clearTimeout(t);
    t = window.setTimeout(() => fn(...a), ms);
  };
};

// ---- linkify / highlight ----

const TOKEN_RE = /(https?:\/\/[\x21-\x7e]+)|(?<![A-Za-z0-9_])(@[A-Za-z0-9_]{1,15})|([#＃][\p{L}\p{N}_]+)/gu;
const TRAILING_PUNCT_RE = /[.,;:!?)\]}'"]+$/;

type Segment =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'url' | 'mention' | 'hashtag'; readonly value: string; readonly href: string };

export const tokenize = (text: string): Segment[] => {
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    const start = m.index ?? 0;
    let value = m[0];
    let kind: 'url' | 'mention' | 'hashtag';
    let href: string;
    if (m[1] !== undefined) {
      kind = 'url';
      const trimmed = value.replace(TRAILING_PUNCT_RE, '');
      value = trimmed;
      href = value;
    } else if (m[2] !== undefined) {
      kind = 'mention';
      href = `https://x.com/${value.slice(1)}`;
    } else {
      kind = 'hashtag';
      href = `https://x.com/hashtag/${encodeURIComponent(value.slice(1))}`;
    }
    if (start > last) out.push({ kind: 'text', value: text.slice(last, start) });
    out.push({ kind, value, href });
    last = start + value.length;
  }
  if (last < text.length) out.push({ kind: 'text', value: text.slice(last) });
  return out;
};

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const termsOf = (q: string | undefined): string[] =>
  (q ?? '')
    .split(/\s+/)
    .map((t) => t.replace(/^-+/, '').replace(/^"|"$/g, ''))
    .filter((t) => t.length > 0);

/** 検索語を <mark> で囲んだノード列を返す */
export const highlight = (text: string, terms: readonly string[]): Node[] => {
  if (terms.length === 0) return [document.createTextNode(text)];
  const re = new RegExp(terms.map(escapeRe).join('|'), 'gi');
  const nodes: Node[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const start = m.index ?? 0;
    if (m[0].length === 0) continue;
    if (start > last) nodes.push(document.createTextNode(text.slice(last, start)));
    nodes.push(h('mark', null, m[0]));
    last = start + m[0].length;
  }
  if (last < text.length) nodes.push(document.createTextNode(text.slice(last)));
  return nodes;
};

/** URL / @mention / #hashtag をリンク化し、検索語をハイライトしたテキスト */
export const linkify = (text: string, terms: readonly string[] = []): DocumentFragment => {
  const frag = document.createDocumentFragment();
  for (const seg of tokenize(text)) {
    if (seg.kind === 'text') {
      for (const n of highlight(seg.value, terms)) frag.appendChild(n);
    } else {
      const a = h('a', { href: seg.href, target: '_blank', rel: 'noopener noreferrer', class: `lnk-${seg.kind}` });
      for (const n of highlight(seg.value, terms)) a.appendChild(n);
      frag.appendChild(a);
    }
  }
  return frag;
};
