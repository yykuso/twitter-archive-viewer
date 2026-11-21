import type { DmConversation, DmMessage } from '../../src/shared/types.ts';
import { fetchConversations, fetchMessages } from './api.ts';
import { h, linkify } from './dom.ts';
import { createFeed, emptyBox, errorBox, spinner } from './feed.ts';
import { formatDateTime, formatDay, dayKey } from './format.ts';
import { openLightbox } from './lightbox.ts';
import { dmHash } from './route.ts';
import { removedBadge } from './tweet.ts';
import type { View } from './timeline.ts';

const VIDEO_RE = /\.(mp4|mov|webm|m4v)(\?|$)/i;

export const createDmList = (): View => {
  const body = h('div', { class: 'dm-list' });
  const el = h('section', { class: 'view view-dm' }, h('div', { class: 'subhead' }, h('span', null, 'ダイレクトメッセージ')), body);
  let alive = true;

  const row = (c: DmConversation): HTMLElement =>
    h('a', { class: 'dm-row', href: dmHash(c.id) },
      h('div', { class: 'dm-row-main' },
        h('div', { class: 'dm-names' }, c.isGroup ? h('span', { class: 'badge badge-group' }, 'グループ') : null, c.participants.join(', ') || c.id),
        h('div', { class: 'dm-meta' }, `${c.messageCount.toLocaleString('ja-JP')} 件`)),
      h('time', { class: 'dm-last', datetime: c.lastAt }, formatDateTime(c.lastAt)));

  const load = (): void => {
    body.replaceChildren(spinner());
    fetchConversations().then((list) => {
      if (!alive) return;
      body.replaceChildren(...(list.length === 0 ? [emptyBox('該当なし')] : list.map(row)));
    }).catch((e: unknown) => {
      if (!alive) return;
      console.error('[dm] conversation list failed', e);
      body.replaceChildren(errorBox(e instanceof Error ? e.message : String(e), load));
    });
  };
  load();
  return { el, destroy: () => { alive = false; } };
};

const renderDmMedia = (urls: readonly string[]): HTMLElement | null => {
  if (urls.length === 0) return null;
  const images = urls.filter((u) => !VIDEO_RE.test(u));
  return h('div', { class: 'dm-media' }, urls.map((u) => VIDEO_RE.test(u)
    ? h('video', { src: u, controls: true, preload: 'metadata', playsinline: true })
    : h('button', { type: 'button', class: 'dm-img', 'aria-label': '画像を拡大', onclick: () => openLightbox(images, images.indexOf(u)) },
        h('img', { src: u, alt: '', loading: 'lazy', decoding: 'async' }))));
};

const renderReactions = (rs: DmMessage['reactions']): HTMLElement | null => {
  if (rs.length === 0) return null;
  const counts = new Map<string, number>();
  for (const r of rs) counts.set(r.reactionKey, (counts.get(r.reactionKey) ?? 0) + 1);
  return h('div', { class: 'dm-reactions' }, [...counts].map(([k, n]) => h('span', { class: 'reaction' }, n > 1 ? `${k} ${n}` : k)));
};

const renderMessage = (m: DmMessage, showSender: boolean): HTMLElement =>
  h('div', { class: `dm-msg ${m.isMine ? 'mine' : 'theirs'}` },
    showSender && !m.isMine ? h('div', { class: 'dm-sender' }, m.senderId) : null,
    h('div', { class: 'bubble' },
      m.text ? h('p', null, linkify(m.text)) : null,
      renderDmMedia(m.media)),
    renderReactions(m.reactions),
    h('div', { class: 'dm-foot' },
      removedBadge(m.removedAt),
      h('time', { class: 'dm-time', datetime: m.createdAt }, formatDateTime(m.createdAt).slice(11))));

export const createDmThread = (id: string): View => {
  let lastDay = '';
  const feed = createFeed<DmMessage>({
    mode: 'button',
    emptyText: 'メッセージがありません',
    load: (cursor) => fetchMessages(id, cursor),
    render: (m) => {
      const day = dayKey(m.createdAt);
      const frag = document.createDocumentFragment();
      if (day !== lastDay) {
        lastDay = day;
        frag.appendChild(h('div', { class: 'dm-day' }, formatDay(m.createdAt)));
      }
      frag.appendChild(renderMessage(m, true));
      return frag;
    },
  });
  const el = h('section', { class: 'view view-dm-thread' },
    h('div', { class: 'subhead' }, h('a', { class: 'btn', href: '#/dm' }, '← 一覧'), h('span', null, 'DM')),
    h('div', { class: 'dm-thread' }, feed.el));
  return { el, destroy: feed.destroy };
};
