import { readEntryText } from './zip.ts';

// ---- 型ガード -------------------------------------------------------------

export type JsonRecord = { readonly [key: string]: unknown };

export const isRecord = (v: unknown): v is JsonRecord =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const describe = (ctx: string, key: string): string => `${ctx}: フィールド "${key}"`;

export const reqRecord = (v: unknown, ctx: string): JsonRecord => {
  if (!isRecord(v)) throw new Error(`${ctx}: オブジェクトではありません`);
  return v;
};

export const reqString = (r: JsonRecord, key: string, ctx: string): string => {
  const v = r[key];
  if (typeof v !== 'string') throw new Error(`${describe(ctx, key)} が文字列ではありません`);
  return v;
};

export const optString = (r: JsonRecord, key: string, ctx: string): string | null => {
  const v = r[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new Error(`${describe(ctx, key)} が文字列ではありません`);
  return v;
};

export const optArray = (r: JsonRecord, key: string, ctx: string): readonly unknown[] => {
  const v = r[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new Error(`${describe(ctx, key)} が配列ではありません`);
  return v;
};

export const optRecord = (r: JsonRecord, key: string, ctx: string): JsonRecord | null => {
  const v = r[key];
  if (v === undefined || v === null) return null;
  if (!isRecord(v)) throw new Error(`${describe(ctx, key)} がオブジェクトではありません`);
  return v;
};

/** 文字列または数値で入っている整数 (欠落時は null) */
export const optInt = (r: JsonRecord, key: string, ctx: string): number | null => {
  const v = r[key];
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN;
  if (!Number.isInteger(n)) throw new Error(`${describe(ctx, key)} が整数ではありません: ${String(v)}`);
  return n;
};

// ---- JS ファイルの読み込み -------------------------------------------------

/** `window.X.part0 = [ ... ]` / `window.__THAR_CONFIG = {...}` の右辺を JSON として読む */
export const parseJsAssignment = (text: string, file: string): unknown => {
  const eq = text.indexOf('=');
  if (eq < 0) throw new Error(`${file}: "=" が見つかりません`);
  const body = text.slice(eq + 1).trim().replace(/;\s*$/, '');
  try {
    return JSON.parse(body);
  } catch (e) {
    throw new Error(`${file}: JSON として解釈できません: ${e instanceof Error ? e.message : String(e)}`);
  }
};

const loadJs = async (zip: string, file: string): Promise<unknown> =>
  parseJsAssignment(await readEntryText(zip, file), file);

// ---- manifest --------------------------------------------------------------

export type Manifest = {
  readonly accountId: string;
  readonly userName: string;
  readonly displayName: string;
  readonly generationDate: string | null;
  /** データ種別 → ファイル名一覧 */
  readonly files: (type: string) => readonly string[];
};

export const parseManifest = (raw: unknown): Manifest => {
  const root = reqRecord(raw, 'manifest.js');
  const userInfo = reqRecord(root['userInfo'], 'manifest.userInfo');
  const archiveInfo = optRecord(root, 'archiveInfo', 'manifest') ?? {};
  const dataTypes = reqRecord(root['dataTypes'], 'manifest.dataTypes');
  return {
    accountId: reqString(userInfo, 'accountId', 'manifest.userInfo'),
    userName: reqString(userInfo, 'userName', 'manifest.userInfo'),
    displayName: reqString(userInfo, 'displayName', 'manifest.userInfo'),
    generationDate: optString(archiveInfo, 'generationDate', 'manifest.archiveInfo'),
    files: (type) => {
      const entry = optRecord(dataTypes, type, 'manifest.dataTypes');
      if (entry === null) return [];
      return optArray(entry, 'files', `manifest.dataTypes.${type}`).map((f, i) =>
        reqString(reqRecord(f, `manifest.dataTypes.${type}.files[${i}]`), 'fileName', `manifest.dataTypes.${type}.files[${i}]`),
      );
    },
  };
};

// ---- ツイート --------------------------------------------------------------

export type RawUrl = { readonly url: string; readonly expanded: string | null };

export type RawMedia = {
  readonly type: string;
  /** 本文中の t.co */
  readonly tcoUrl: string | null;
  readonly mediaUrl: string;
  readonly width: number | null;
  readonly height: number | null;
  /** mp4 バリアントの URL */
  readonly mp4Urls: readonly string[];
};

export type RawTweet = {
  readonly id: string;
  readonly createdAt: string;
  readonly fullText: string;
  readonly lang: string | null;
  readonly source: string | null;
  readonly favoriteCount: number;
  readonly retweetCount: number;
  readonly inReplyToStatusId: string | null;
  readonly inReplyToScreenName: string | null;
  readonly urls: readonly RawUrl[];
  readonly media: readonly RawMedia[];
  readonly deletedAt: string | null;
};

const parseMedia = (v: unknown, ctx: string): RawMedia => {
  const m = reqRecord(v, ctx);
  const sizes = optRecord(m, 'sizes', ctx);
  const large = sizes === null ? null : optRecord(sizes, 'large', `${ctx}.sizes`);
  const videoInfo = optRecord(m, 'video_info', ctx);
  const variants = videoInfo === null ? [] : optArray(videoInfo, 'variants', `${ctx}.video_info`);
  const mp4Urls = variants.flatMap((variant, i) => {
    const vr = reqRecord(variant, `${ctx}.variants[${i}]`);
    return optString(vr, 'content_type', ctx) === 'video/mp4' ? [reqString(vr, 'url', `${ctx}.variants[${i}]`)] : [];
  });
  return {
    type: reqString(m, 'type', ctx),
    tcoUrl: optString(m, 'url', ctx),
    mediaUrl: reqString(m, 'media_url_https', ctx),
    width: large === null ? null : optInt(large, 'w', `${ctx}.sizes.large`),
    height: large === null ? null : optInt(large, 'h', `${ctx}.sizes.large`),
    mp4Urls,
  };
};

export const parseTweetItem = (item: unknown, file: string, index: number): RawTweet => {
  const wrapper = reqRecord(item, `${file}[${index}]`);
  const t = reqRecord(wrapper['tweet'], `${file}[${index}].tweet`);
  const id = reqString(t, 'id_str', `${file}[${index}]`);
  const ctx = `${file} tweet ${id}`;
  const entities = optRecord(t, 'entities', ctx) ?? {};
  const extended = optRecord(t, 'extended_entities', ctx);
  const extendedMedia = extended === null ? [] : optArray(extended, 'media', `${ctx}.extended_entities`);
  const mediaList = extendedMedia.length > 0 ? extendedMedia : optArray(entities, 'media', `${ctx}.entities`);
  return {
    id,
    createdAt: reqString(t, 'created_at', ctx),
    fullText: reqString(t, 'full_text', ctx),
    lang: optString(t, 'lang', ctx),
    source: optString(t, 'source', ctx),
    favoriteCount: optInt(t, 'favorite_count', ctx) ?? 0,
    retweetCount: optInt(t, 'retweet_count', ctx) ?? 0,
    inReplyToStatusId: optString(t, 'in_reply_to_status_id_str', ctx),
    inReplyToScreenName: optString(t, 'in_reply_to_screen_name', ctx),
    urls: optArray(entities, 'urls', `${ctx}.entities`).map((u, i) => {
      const ur = reqRecord(u, `${ctx}.urls[${i}]`);
      return { url: reqString(ur, 'url', ctx), expanded: optString(ur, 'expanded_url', ctx) };
    }),
    media: mediaList.map((m, i) => parseMedia(m, `${ctx}.media[${i}]`)),
    deletedAt: optString(t, 'deleted_at', ctx),
  };
};

const loadArray = async (zip: string, file: string): Promise<readonly unknown[]> => {
  const data = await loadJs(zip, file);
  if (!Array.isArray(data)) throw new Error(`${file}: 配列ではありません`);
  return data;
};

export const loadTweets = async (zip: string, files: readonly string[]): Promise<readonly RawTweet[]> => {
  const parts = await Promise.all(
    files.map(async (file) => (await loadArray(zip, file)).map((item, i) => parseTweetItem(item, file, i))),
  );
  return parts.flat();
};

// ---- いいね ----------------------------------------------------------------

export type RawLike = { readonly tweetId: string; readonly fullText: string; readonly expandedUrl: string | null };

export const loadLikes = async (zip: string, files: readonly string[]): Promise<readonly RawLike[]> => {
  const parts = await Promise.all(
    files.map(async (file) =>
      (await loadArray(zip, file)).map((item, i): RawLike => {
        const ctx = `${file}[${i}]`;
        const like = reqRecord(reqRecord(item, ctx)['like'], `${ctx}.like`);
        return {
          tweetId: reqString(like, 'tweetId', ctx),
          fullText: optString(like, 'fullText', ctx) ?? '',
          expandedUrl: optString(like, 'expandedUrl', ctx),
        };
      }),
    ),
  );
  return parts.flat();
};

// ---- DM --------------------------------------------------------------------

export type RawDmMessage = {
  readonly id: string;
  readonly senderId: string;
  readonly recipientId: string | null;
  readonly text: string;
  readonly createdAt: string;
  readonly mediaUrls: readonly string[];
  readonly reactions: readonly { readonly senderId: string; readonly reactionKey: string }[];
  readonly urls: readonly RawUrl[];
};

export type RawDmConversation = {
  readonly id: string;
  readonly isGroup: boolean;
  readonly messages: readonly RawDmMessage[];
};

const parseDmMessage = (mc: JsonRecord, ctx: string): RawDmMessage => ({
  id: reqString(mc, 'id', ctx),
  senderId: reqString(mc, 'senderId', ctx),
  recipientId: optString(mc, 'recipientId', ctx),
  text: optString(mc, 'text', ctx) ?? '',
  createdAt: reqString(mc, 'createdAt', ctx),
  mediaUrls: optArray(mc, 'mediaUrls', ctx).map((u, i) => {
    if (typeof u !== 'string') throw new Error(`${ctx}: mediaUrls[${i}] が文字列ではありません`);
    return u;
  }),
  reactions: optArray(mc, 'reactions', ctx).map((r, i) => {
    const rr = reqRecord(r, `${ctx}.reactions[${i}]`);
    return { senderId: reqString(rr, 'senderId', ctx), reactionKey: reqString(rr, 'reactionKey', ctx) };
  }),
  urls: optArray(mc, 'urls', ctx).map((u, i) => {
    const ur = reqRecord(u, `${ctx}.urls[${i}]`);
    return { url: reqString(ur, 'url', ctx), expanded: optString(ur, 'expanded', ctx) };
  }),
});

export const loadDms = async (
  zip: string,
  files: readonly string[],
  isGroup: boolean,
): Promise<readonly RawDmConversation[]> => {
  const parts = await Promise.all(
    files.map(async (file) =>
      (await loadArray(zip, file)).map((item, i): RawDmConversation => {
        const ctx = `${file}[${i}]`;
        const conv = reqRecord(reqRecord(item, ctx)['dmConversation'], `${ctx}.dmConversation`);
        const id = reqString(conv, 'conversationId', ctx);
        const messages = optArray(conv, 'messages', `${ctx}(${id})`).flatMap((m, j) => {
          const mr = reqRecord(m, `${file} conversation ${id} messages[${j}]`);
          const mc = optRecord(mr, 'messageCreate', `${file} conversation ${id}`);
          return mc === null ? [] : [parseDmMessage(mc, `${file} conversation ${id} message[${j}]`)];
        });
        return { id, isGroup, messages };
      }),
    ),
  );
  return parts.flat();
};

// ---- アカウント / プロフィール ---------------------------------------------

export type RawProfile = { readonly bio: string | null; readonly avatarMediaUrl: string | null };

export const loadProfile = async (zip: string, files: readonly string[]): Promise<RawProfile> => {
  const file = files[0];
  if (file === undefined) return { bio: null, avatarMediaUrl: null };
  const arr = await loadArray(zip, file);
  const first = arr[0];
  if (first === undefined) return { bio: null, avatarMediaUrl: null };
  const p = reqRecord(reqRecord(first, file)['profile'], `${file}.profile`);
  const desc = optRecord(p, 'description', file);
  return {
    bio: desc === null ? null : optString(desc, 'bio', file),
    avatarMediaUrl: optString(p, 'avatarMediaUrl', file),
  };
};
