import type { RawDmConversation, RawLike, RawMedia, RawTweet, RawUrl } from './parse.ts';

// ---- 出力行の型 ------------------------------------------------------------

export type MediaType = 'photo' | 'video' | 'animated_gif';

export type TweetRow = {
  readonly id: string;
  readonly createdAt: number;
  readonly text: string;
  readonly lang: string | null;
  readonly source: string | null;
  readonly inReplyToStatusId: string | null;
  readonly inReplyToScreenName: string | null;
  readonly isRetweet: boolean;
  readonly isReply: boolean;
  readonly hasMedia: boolean;
  readonly favoriteCount: number;
  readonly retweetCount: number;
  readonly deletedAt: number | null;
};

export type MediaRow = {
  readonly tweetId: string;
  readonly idx: number;
  readonly type: MediaType;
  readonly file: string | null;
  readonly width: number | null;
  readonly height: number | null;
};

export type TweetWithMedia = { readonly tweet: TweetRow; readonly media: readonly MediaRow[] };

export type LikeRow = { readonly tweetId: string; readonly fullText: string; readonly expandedUrl: string | null; readonly ord: number };

export type DmConversationRow = {
  readonly id: string;
  readonly isGroup: boolean;
  readonly participants: readonly string[];
  readonly lastAt: number;
  readonly messageCount: number;
};

export type DmMessageRow = {
  readonly id: string;
  readonly conversationId: string;
  readonly senderId: string;
  readonly createdAt: number;
  readonly text: string;
  readonly media: readonly string[];
  readonly reactions: readonly { readonly senderId: string; readonly reactionKey: string }[];
};

// ---- メディアファイル索引 --------------------------------------------------

/** `<dir>/<id>` → その ID に属するファイルのフルパス一覧 */
export type MediaIndex = {
  readonly has: (path: string) => boolean;
  readonly byOwner: (dir: string, ownerId: string) => readonly string[];
};

export const buildMediaIndex = (entries: readonly string[], dirs: readonly string[]): MediaIndex => {
  const all = new Set(entries);
  const owners = new Map<string, string[]>();
  for (const entry of entries) {
    const dir = dirs.find((d) => entry.startsWith(`${d}/`));
    if (dir === undefined) continue;
    const name = entry.slice(dir.length + 1);
    const dash = name.indexOf('-');
    if (dash <= 0) continue;
    const key = `${dir}/${name.slice(0, dash)}`;
    const list = owners.get(key);
    if (list === undefined) owners.set(key, [entry]);
    else list.push(entry);
  }
  return {
    has: (path) => all.has(path),
    byOwner: (dir, ownerId) => owners.get(`${dir}/${ownerId}`) ?? [],
  };
};

// ---- テキスト --------------------------------------------------------------

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export const decodeHtmlEntities = (s: string): string =>
  s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body] ?? whole;
  });

/** 各 t.co を展開 URL に置換 (展開先が無ければそのまま) */
export const expandUrls = (text: string, urls: readonly RawUrl[]): string =>
  urls.reduce((acc, u) => (u.expanded === null ? acc : acc.split(u.url).join(u.expanded)), text);

const removeUrls = (text: string, urls: readonly string[]): string =>
  urls.reduce((acc, u) => acc.split(u).join(''), text);

export const stripTags = (html: string): string => decodeHtmlEntities(html.replace(/<[^>]*>/g, '')).trim();

export const parseTwitterDate = (s: string, ctx: string): number => {
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw new Error(`${ctx}: 日時を解釈できません: ${s}`);
  return ms;
};

const parseIsoDate = parseTwitterDate;

const lastSegment = (url: string): string => {
  const noQuery = url.split(/[?#]/)[0] ?? url;
  return noQuery.slice(noQuery.lastIndexOf('/') + 1);
};

// ---- ツイート --------------------------------------------------------------

const MEDIA_TYPES: readonly string[] = ['photo', 'video', 'animated_gif'];
const isMediaType = (s: string): s is MediaType => MEDIA_TYPES.includes(s);

/** 1 ツイート分のメディアを解決する。video/gif は mp4 バリアント名 → 未使用の任意 mp4 の順 */
const resolveTweetMedia = (tweetId: string, media: readonly RawMedia[], dir: string, index: MediaIndex): readonly MediaRow[] => {
  const used = new Set<string>();
  return media.map((m, idx): MediaRow => {
    if (!isMediaType(m.type)) throw new Error(`ツイート ${tweetId}: 未知のメディア種別 ${m.type}`);
    const pick = (): string | null => {
      if (m.type === 'photo') {
        const p = `${dir}/${tweetId}-${lastSegment(m.mediaUrl)}`;
        return index.has(p) ? p : null;
      }
      const byVariant = m.mp4Urls.map((u) => `${dir}/${tweetId}-${lastSegment(u)}`).find((p) => index.has(p) && !used.has(p));
      if (byVariant !== undefined) return byVariant;
      return index.byOwner(dir, tweetId).find((p) => p.endsWith('.mp4') && !used.has(p)) ?? null;
    };
    const file = pick();
    if (file !== null) used.add(file);
    return { tweetId, idx, type: m.type, file, width: m.width, height: m.height };
  });
};

export const transformTweet = (raw: RawTweet, mediaDir: string, index: MediaIndex): TweetWithMedia => {
  const ctx = `ツイート ${raw.id}`;
  const withoutMedia = removeUrls(
    expandUrls(raw.fullText, raw.urls),
    raw.media.flatMap((m) => (m.tcoUrl === null ? [] : [m.tcoUrl])),
  );
  return {
    tweet: {
      id: raw.id,
      createdAt: parseTwitterDate(raw.createdAt, ctx),
      text: decodeHtmlEntities(withoutMedia).trim(),
      lang: raw.lang,
      source: raw.source === null ? null : stripTags(raw.source),
      inReplyToStatusId: raw.inReplyToStatusId,
      inReplyToScreenName: raw.inReplyToScreenName,
      isRetweet: raw.fullText.startsWith('RT @'),
      isReply: raw.inReplyToStatusId !== null,
      hasMedia: raw.media.length > 0,
      favoriteCount: raw.favoriteCount,
      retweetCount: raw.retweetCount,
      deletedAt: raw.deletedAt === null ? null : parseTwitterDate(raw.deletedAt, ctx),
    },
    media: resolveTweetMedia(raw.id, raw.media, mediaDir, index),
  };
};

/** tweets と deleted-tweets を統合。同一 ID は先勝ち (tweets.js が優先)。ID 重複は除去 */
export const transformAllTweets = (
  tweets: readonly RawTweet[],
  deleted: readonly RawTweet[],
  index: MediaIndex,
): readonly TweetWithMedia[] => {
  const seen = new Set<string>();
  const pick = (raws: readonly RawTweet[], dir: string): TweetWithMedia[] =>
    raws.flatMap((raw) => {
      if (seen.has(raw.id)) return [];
      seen.add(raw.id);
      return [transformTweet(raw, dir, index)];
    });
  return [...pick(tweets, 'data/tweets_media'), ...pick(deleted, 'data/deleted_tweets_media')];
};

// ---- いいね ----------------------------------------------------------------

export const transformLikes = (raws: readonly RawLike[]): readonly LikeRow[] => {
  const seen = new Set<string>();
  return raws
    .flatMap((r) => {
      if (seen.has(r.tweetId)) return [];
      seen.add(r.tweetId);
      return [r];
    })
    .map((r, ord) => ({ tweetId: r.tweetId, fullText: decodeHtmlEntities(r.fullText), expandedUrl: r.expandedUrl, ord }));
};

// ---- DM --------------------------------------------------------------------

export type TransformedDms = {
  readonly conversations: readonly DmConversationRow[];
  readonly messages: readonly DmMessageRow[];
  /** メッセージを 1 件も持たないため除外した会話の数 */
  readonly emptyConversations: number;
};

export const transformDms = (convs: readonly RawDmConversation[], index: MediaIndex): TransformedDms => {
  const seenMessages = new Set<string>();
  const seenConvs = new Set<string>();
  const conversations: DmConversationRow[] = [];
  const messages: DmMessageRow[] = [];
  let emptyConversations = 0;
  for (const conv of convs) {
    if (seenConvs.has(conv.id)) continue;
    seenConvs.add(conv.id);
    const mediaDir = conv.isGroup ? 'data/direct_messages_group_media' : 'data/direct_messages_media';
    const rows = conv.messages.flatMap((m): DmMessageRow[] => {
      if (seenMessages.has(m.id)) return [];
      seenMessages.add(m.id);
      const ctx = `DM ${m.id}`;
      return [
        {
          id: m.id,
          conversationId: conv.id,
          senderId: m.senderId,
          createdAt: parseIsoDate(m.createdAt, ctx),
          text: decodeHtmlEntities(expandUrls(m.text, m.urls)),
          media: m.mediaUrls.map((u) => `${mediaDir}/${m.id}-${lastSegment(u)}`).filter((p) => index.has(p)),
          reactions: m.reactions.map((r) => ({ senderId: r.senderId, reactionKey: r.reactionKey })),
        },
      ];
    });
    if (conv.messages.length === 0) {
      emptyConversations += 1;
      continue;
    }
    const participants = [...new Set(conv.messages.flatMap((m) => (m.recipientId === null ? [m.senderId] : [m.senderId, m.recipientId])))];
    conversations.push({
      id: conv.id,
      isGroup: conv.isGroup,
      participants,
      lastAt: rows.reduce((max, r) => Math.max(max, r.createdAt), 0),
      messageCount: rows.length,
    });
    messages.push(...rows);
  }
  return { conversations, messages, emptyConversations };
};

// ---- アバター --------------------------------------------------------------

export const resolveAvatar = (accountId: string, avatarUrl: string | null, index: MediaIndex): string | null => {
  if (avatarUrl === null) return null;
  const p = `data/profile_media/${accountId}-${lastSegment(avatarUrl)}`;
  return index.has(p) ? p : null;
};
