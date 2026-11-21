import type { Media, Tweet } from '../../src/shared/types.ts';
import { h, linkify } from './dom.ts';
import { formatCount, formatDateTime, formatDay } from './format.ts';
import { openLightbox } from './lightbox.ts';
import { tweetHash } from './route.ts';

export type TweetCtx = {
  /** 自分のアカウント名 (原文リンク用)。不明なら null */
  readonly username: string | null;
  readonly terms: readonly string[];
};

export const originalUrl = (ctx: TweetCtx, id: string): string =>
  `https://x.com/${ctx.username ?? 'i'}/status/${encodeURIComponent(id)}`;

const renderMediaItem = (m: Media, photoUrls: readonly string[]): HTMLElement => {
  if (m.url === null) return h('div', { class: 'media-item media-missing' }, 'メディアなし');
  const url = m.url;
  if (m.type === 'photo') {
    const photoIndex = photoUrls.indexOf(url);
    const img = h('img', { src: url, alt: '', loading: 'lazy', decoding: 'async' });
    const btn = h('button', { type: 'button', class: 'media-item media-photo', 'aria-label': '画像を拡大', onclick: () => openLightbox(photoUrls, photoIndex) }, img);
    return btn;
  }
  const v = h('video', { src: url, preload: 'metadata', playsinline: true });
  if (m.type === 'animated_gif') {
    v.muted = true;
    v.loop = true;
    v.autoplay = true;
    v.setAttribute('muted', '');
    v.setAttribute('loop', '');
    v.setAttribute('autoplay', '');
  } else {
    v.controls = true;
  }
  return h('div', { class: `media-item media-video${m.type === 'animated_gif' ? ' media-gif' : ''}` }, v);
};

export const renderMedia = (media: readonly Media[]): HTMLElement | null => {
  if (media.length === 0) return null;
  const items = media.slice(0, 4);
  const photoUrls = items.flatMap((m) => (m.type === 'photo' && m.url !== null ? [m.url] : []));
  const single = items[0];
  const style = items.length === 1 && single && single.width && single.height && single.type !== 'photo'
    ? `aspect-ratio:${single.width}/${single.height}` : undefined;
  return h('div', { class: `media-grid media-${items.length}`, style }, items.map((m) => renderMediaItem(m, photoUrls)));
};

/** 「消失 YYYY/MM/DD」バッジ。removedAt が無ければ null */
export const removedBadge = (removedAt: string | null | undefined): HTMLElement | null =>
  removedAt
    ? h('span', { class: 'badge badge-removed', title: 'このアーカイブ以降で見つからなくなりました' }, `消失 ${formatDay(removedAt)}`)
    : null;

export type CardOptions = { readonly large?: boolean; readonly role?: 'parent' | 'reply' | 'main' };

export const renderTweet = (t: Tweet, ctx: TweetCtx, opts: CardOptions = {}): HTMLElement => {
  const badges: Node[] = [];
  if (t.isRetweet) badges.push(h('span', { class: 'badge badge-rt' }, '🔁 RT'));
  if (t.deletedAt !== null) badges.push(h('span', { class: 'badge badge-deleted' }, '削除済み'));
  const rb = removedBadge(t.removedAt);
  if (rb) badges.push(rb);

  const header = h('div', { class: 'tw-head' },
    h('a', { class: 'tw-date', href: tweetHash(t.id) }, h('time', { datetime: t.createdAt }, formatDateTime(t.createdAt))),
    badges,
    h('a', { class: 'tw-ext', href: originalUrl(ctx, t.id), target: '_blank', rel: 'noopener noreferrer', title: 'X で開く' }, 'X ↗'));

  const reply = t.replyTo
    ? h('div', { class: 'tw-reply' },
        h('a', { href: tweetHash(t.replyTo.id) }, t.replyTo.screenName ? `↩ @${t.replyTo.screenName} への返信` : '↩ 返信'))
    : null;

  return h('article', { class: `tweet${opts.large ? ' tweet-large' : ''}${opts.role ? ` tweet-${opts.role}` : ''}`, 'data-id': t.id },
    header,
    reply,
    t.text ? h('p', { class: 'tw-text' }, linkify(t.text, ctx.terms)) : null,
    renderMedia(t.media),
    h('div', { class: 'tw-stats' },
      h('span', null, `♥ ${formatCount(t.favoriteCount)}`),
      h('span', null, `🔁 ${formatCount(t.retweetCount)}`)));
};
