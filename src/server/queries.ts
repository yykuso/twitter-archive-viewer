import type { DatabaseSync, SQLInputValue, SQLOutputValue, StatementSync } from 'node:sqlite';
import type {
  DmConversation,
  DmMessage,
  ImportRecord,
  ImportStats,
  Like,
  Media,
  MediaType,
  Meta,
  MonthCount,
  Page,
  Tweet,
  TweetDetail,
} from '../shared/types.ts';
import type { DbHolder } from './db-holder.ts';
import { localMonth, nextMonth, zonedMidnightToUtc } from './timezone.ts';
import { encodeCursor, type KeysetCursor, type TweetFilter } from './params.ts';

type Row = Record<string, SQLOutputValue>;

// ---------- row accessors (pure) ----------

const str = (r: Row, k: string): string => {
  const v = r[k];
  if (typeof v !== 'string') throw new Error(`column ${k}: expected string, got ${typeof v}`);
  return v;
};
const strOrNull = (r: Row, k: string): string | null => {
  const v = r[k];
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') throw new Error(`column ${k}: expected string|null, got ${typeof v}`);
  return v;
};
const num = (r: Row, k: string): number => {
  const v = r[k];
  if (typeof v !== 'number') throw new Error(`column ${k}: expected number, got ${typeof v}`);
  return v;
};
const numOrNull = (r: Row, k: string): number | null => {
  const v = r[k];
  if (v === null || v === undefined) return null;
  if (typeof v !== 'number') throw new Error(`column ${k}: expected number|null, got ${typeof v}`);
  return v;
};

const toIso = (ms: number): string => new Date(ms).toISOString();
const toIsoOrNull = (ms: number | null): string | null => (ms === null ? null : toIso(ms));

/** メディア相対パス → URL (各セグメントを URL エンコード) */
export const mediaUrl = (relPath: string): string =>
  `/media/${relPath.split('/').map(encodeURIComponent).join('/')}`;

/** meta の日時値は ISO 文字列でも epoch ms でも受け付けて ISO に正規化する */
export const normalizeInstant = (v: string | undefined): string | null => {
  if (v === undefined || v === '') return null;
  if (/^\d{10,16}$/.test(v)) return toIso(Number(v));
  const t = Date.parse(v);
  return Number.isNaN(t) ? v : new Date(t).toISOString();
};

const isMediaType = (v: string): v is MediaType =>
  v === 'photo' || v === 'video' || v === 'animated_gif';

export const toMedia = (r: Row): Media => {
  const type = str(r, 'type');
  if (!isMediaType(type)) throw new Error(`unknown media type: ${type}`);
  const file = strOrNull(r, 'file');
  return {
    type,
    url: file === null ? null : mediaUrl(file),
    width: numOrNull(r, 'width'),
    height: numOrNull(r, 'height'),
  };
};

export const toTweet = (r: Row, media: readonly Media[]): Tweet => {
  const replyId = strOrNull(r, 'in_reply_to_status_id');
  return {
    id: str(r, 'id'),
    createdAt: toIso(num(r, 'created_at')),
    text: str(r, 'text'),
    lang: strOrNull(r, 'lang'),
    source: strOrNull(r, 'source'),
    replyTo: replyId === null ? null : { id: replyId, screenName: strOrNull(r, 'in_reply_to_screen_name') },
    isRetweet: num(r, 'is_retweet') !== 0,
    favoriteCount: num(r, 'favorite_count'),
    retweetCount: num(r, 'retweet_count'),
    deletedAt: toIsoOrNull(numOrNull(r, 'deleted_at')),
    removedAt: toIsoOrNull(numOrNull(r, 'removed_at')),
    media,
  };
};

const parseJson = (raw: string, what: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`invalid JSON in ${what}: ${e instanceof Error ? e.message : String(e)}`);
  }
};

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

const parseStringArray = (raw: string, what: string): string[] => {
  const v = parseJson(raw, what);
  if (!isStringArray(v)) throw new Error(`${what}: expected string[]`);
  return v;
};

const parseReactions = (raw: string, what: string): DmMessage['reactions'] => {
  const v = parseJson(raw, what);
  if (!Array.isArray(v)) throw new Error(`${what}: expected array`);
  return v.map((x: unknown) => {
    if (typeof x !== 'object' || x === null) throw new Error(`${what}: bad reaction`);
    const o = x as Record<string, unknown>;
    if (typeof o['senderId'] !== 'string' || typeof o['reactionKey'] !== 'string') {
      throw new Error(`${what}: bad reaction`);
    }
    return { senderId: o['senderId'], reactionKey: o['reactionKey'] };
  });
};

export const toDmMessage = (r: Row, myId: string): DmMessage => ({
  id: str(r, 'id'),
  senderId: str(r, 'sender_id'),
  isMine: str(r, 'sender_id') === myId,
  createdAt: toIso(num(r, 'created_at')),
  text: str(r, 'text'),
  media: parseStringArray(str(r, 'media'), `dm_messages.media(${str(r, 'id')})`).map(mediaUrl),
  reactions: parseReactions(str(r, 'reactions'), `dm_messages.reactions(${str(r, 'id')})`),
  removedAt: toIsoOrNull(numOrNull(r, 'removed_at')),
});

export const toDmConversation = (r: Row): DmConversation => ({
  id: str(r, 'id'),
  isGroup: num(r, 'is_group') !== 0,
  participants: parseStringArray(str(r, 'participants'), `dm_conversations.participants(${str(r, 'id')})`),
  lastAt: toIso(num(r, 'last_at')),
  messageCount: num(r, 'message_count'),
});

/** limit+1 件取得した行から Page を作る */
export const toPage = <R, T>(
  rows: readonly R[],
  limit: number,
  map: (r: R) => T,
  cursorOf: (last: R) => string,
): Page<T> => {
  const pageRows = rows.slice(0, limit);
  const last = pageRows[pageRows.length - 1];
  const hasMore = rows.length > limit && last !== undefined;
  return { items: pageRows.map(map), nextCursor: hasMore ? cursorOf(last) : null };
};

// ---------- SQL builders (pure) ----------

export type BuiltQuery = { readonly sql: string; readonly params: readonly SQLInputValue[] };

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const ftsPhrase = (s: string): string => `"${s.replaceAll('"', '""')}"`;
/** トライグラムは 3 文字以上必要 (コードポイント数で判定) */
const isFtsTerm = (s: string): boolean => [...s].length >= 3;

/**
 * 消失したアーカイブ日 = last_seen_at より後で最小の generated_at。
 * last_seen_at が最新なら該当なしで NULL (= 消失していない)。
 */
const removedAtExpr = (alias: string): string =>
  `(SELECT MIN(generated_at) FROM imports WHERE generated_at > ${alias}.last_seen_at) AS removed_at`;

const TWEET_COLS =
  't.id, t.created_at, t.text, t.lang, t.source, t.in_reply_to_status_id, t.in_reply_to_screen_name, ' +
  't.is_retweet, t.favorite_count, t.retweet_count, t.deleted_at, ' +
  removedAtExpr('t');

const typeCondition = (type: TweetFilter['type']): string | null => {
  switch (type) {
    case 'original':
      return 't.is_reply = 0 AND t.is_retweet = 0';
    case 'reply':
      return 't.is_reply = 1';
    case 'retweet':
      return 't.is_retweet = 1';
    case 'all':
      return null;
  }
};

/** 「消失」= last_seen_at が取り込み済みの最大 generated_at より古い (取り込み無しなら該当なし) */
const removedCondition = (removed: TweetFilter['removed']): string | null => {
  switch (removed) {
    case 'include':
      return null;
    case 'exclude':
      return 't.last_seen_at >= ? AND t.deleted_at IS NULL';
    case 'only':
      return '(t.last_seen_at < ? OR t.deleted_at IS NOT NULL)';
  }
};

export const buildTweetQuery = (f: TweetFilter, maxGenerated: number | null): BuiltQuery => {
  const conds: string[] = [];
  const params: SQLInputValue[] = [];

  const ftsTerms = f.terms.filter(isFtsTerm);
  const likeTerms = f.terms.filter((t) => !isFtsTerm(t));
  const join = ftsTerms.length > 0 ? ' JOIN tweets_fts ON tweets_fts.rowid = t.rowid' : '';
  if (ftsTerms.length > 0) {
    conds.push('tweets_fts MATCH ?');
    params.push(ftsTerms.map(ftsPhrase).join(' AND '));
  }
  for (const term of likeTerms) {
    conds.push("t.text LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLike(term)}%`);
  }
  if (f.fromMs !== null) {
    conds.push('t.created_at >= ?');
    params.push(f.fromMs);
  }
  if (f.toMs !== null) {
    conds.push('t.created_at < ?');
    params.push(f.toMs);
  }
  const typeCond = typeCondition(f.type);
  if (typeCond !== null) conds.push(typeCond);
  if (f.mediaOnly) conds.push('t.has_media = 1');
  const removedCond = removedCondition(f.removed);
  if (removedCond !== null) {
    conds.push(removedCond);
    params.push(maxGenerated ?? 0);
  }
  if (f.cursor !== null) {
    const op = f.order === 'desc' ? '<' : '>';
    conds.push(`(t.created_at ${op} ? OR (t.created_at = ? AND t.id ${op} ?))`);
    params.push(f.cursor.createdAt, f.cursor.createdAt, f.cursor.id);
  }
  const dir = f.order === 'desc' ? 'DESC' : 'ASC';
  const where = conds.length > 0 ? ` WHERE ${conds.join(' AND ')}` : '';
  const sql = `SELECT ${TWEET_COLS} FROM tweets t${join}${where} ORDER BY t.created_at ${dir}, t.id ${dir} LIMIT ?`;
  params.push(f.limit + 1);
  return { sql, params };
};

export const buildLikesQuery = (
  terms: readonly string[],
  cursor: number | null,
  limit: number,
): BuiltQuery => {
  const conds: string[] = [];
  const params: SQLInputValue[] = [];
  for (const term of terms) {
    conds.push("full_text LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLike(term)}%`);
  }
  if (cursor !== null) {
    conds.push('ord > ?');
    params.push(cursor);
  }
  const where = conds.length > 0 ? ` WHERE ${conds.join(' AND ')}` : '';
  params.push(limit + 1);
  return {
    sql: `SELECT tweet_id, full_text, expanded_url, ord, ${removedAtExpr('likes')} FROM likes${where} ORDER BY ord ASC LIMIT ?`,
    params,
  };
};

// ---------- queries (db edge) ----------

export type Queries = ReturnType<typeof createQueries>;

/** import_stats JSON の検証 (壊れていれば例外) */
export const parseImportStats = (raw: string, what: string): ImportStats => {
  const rec = (v: unknown, name: string): Record<string, unknown> => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`${what}: ${name} must be an object`);
    return v as Record<string, unknown>;
  };
  const n = (o: Record<string, unknown>, k: string): number => {
    const v = o[k];
    if (typeof v !== 'number') throw new Error(`${what}: ${k} must be a number`);
    return v;
  };
  const table = (v: unknown, name: string) => {
    const o = rec(v, name);
    return { added: n(o, 'added'), updated: n(o, 'updated'), seen: n(o, 'seen') };
  };
  const root = rec(parseJson(raw, what), 'stats');
  const removed = rec(root['removed'], 'removed');
  return {
    tweets: table(root['tweets'], 'tweets'),
    likes: table(root['likes'], 'likes'),
    dmMessages: table(root['dmMessages'], 'dmMessages'),
    removed: { tweets: n(removed, 'tweets'), likes: n(removed, 'likes'), dmMessages: n(removed, 'dmMessages') },
    mediaFiles: n(root, 'mediaFiles'),
  };
};

export const toImportRecord = (r: Row): ImportRecord => ({
  id: num(r, 'id'),
  fileName: str(r, 'file_name'),
  fileSize: num(r, 'file_size'),
  generatedAt: toIso(num(r, 'generated_at')),
  startedAt: toIso(num(r, 'started_at')),
  finishedAt: toIso(num(r, 'finished_at')),
  stats: parseImportStats(str(r, 'stats'), `imports.stats(${num(r, 'id')})`),
});

const IMPORT_COLS = 'id, file_name, file_size, generated_at, started_at, finished_at, stats';

/**
 * 現在のハンドル (holder.get()) に対するクエリ群。
 * 準備済み文のキャッシュと maxGeneratedAt はハンドル単位 (WeakMap) なので、reopen 後は自動的に作り直される。
 */
export const createQueries = (holder: DbHolder, timeZone: string) => {
  const caches = new WeakMap<DatabaseSync, Map<string, StatementSync>>();
  const maxGenerated = new WeakMap<DatabaseSync, number | null>();
  const stmt = (sql: string): StatementSync => {
    const db = holder.get();
    let cache = caches.get(db);
    if (cache === undefined) {
      cache = new Map();
      caches.set(db, cache);
    }
    const hit = cache.get(sql);
    if (hit !== undefined) return hit;
    const s = db.prepare(sql);
    cache.set(sql, s);
    return s;
  };
  const all = (q: BuiltQuery | { sql: string; params: readonly SQLInputValue[] }): Row[] =>
    stmt(q.sql).all(...q.params);
  const get = (sql: string, ...params: SQLInputValue[]): Row | undefined => stmt(sql).get(...params);

  /** 取り込み済みアーカイブの最大 generated_at (無ければ null)。ハンドルごとにキャッシュ */
  const maxGeneratedAt = (): number | null => {
    const db = holder.get();
    if (maxGenerated.has(db)) return maxGenerated.get(db) ?? null;
    const r = get('SELECT MAX(generated_at) AS m FROM imports');
    const m = r === undefined ? null : numOrNull(r, 'm');
    maxGenerated.set(db, m);
    return m;
  };

  const loadMedia = (tweetIds: readonly string[]): Map<string, Media[]> => {
    const byTweet = new Map<string, Media[]>();
    if (tweetIds.length === 0) return byTweet;
    const placeholders = tweetIds.map(() => '?').join(',');
    const rows = all({
      sql: `SELECT tweet_id, idx, type, file, width, height FROM media WHERE tweet_id IN (${placeholders}) ORDER BY tweet_id, idx`,
      params: tweetIds,
    });
    for (const r of rows) {
      const id = str(r, 'tweet_id');
      const list = byTweet.get(id) ?? [];
      list.push(toMedia(r));
      byTweet.set(id, list);
    }
    return byTweet;
  };

  const hydrate = (rows: readonly Row[]): Tweet[] => {
    const media = loadMedia(rows.map((r) => str(r, 'id')));
    return rows.map((r) => toTweet(r, media.get(str(r, 'id')) ?? []));
  };

  const metaMap = (): Map<string, string> =>
    new Map(all({ sql: 'SELECT key, value FROM meta', params: [] }).map((r) => [str(r, 'key'), str(r, 'value')]));

  const count = (table: 'tweets' | 'likes' | 'dm_conversations'): number => {
    const r = get(`SELECT COUNT(*) AS n FROM ${table}`);
    return r === undefined ? 0 : num(r, 'n');
  };

  const myAccountId = (): string => {
    const r = get("SELECT value FROM meta WHERE key = 'account_id'");
    return r === undefined ? '' : str(r, 'value');
  };

  return {
    meta: (): Meta => {
      const m = metaMap();
      const accountId = m.get('account_id');
      const range = get('SELECT MIN(created_at) AS first, MAX(created_at) AS last FROM tweets');
      const avatar = m.get('avatar_file');
      const first = range === undefined ? null : numOrNull(range, 'first');
      const last = range === undefined ? null : numOrNull(range, 'last');
      const importCount = get('SELECT COUNT(*) AS n FROM imports');
      return {
        account:
          accountId === undefined
            ? null
            : { id: accountId, username: m.get('username') ?? '', displayName: m.get('display_name') ?? '' },
        profile: {
          bio: m.get('bio') ?? null,
          avatarUrl: avatar === undefined || avatar === '' ? null : mediaUrl(avatar),
        },
        archiveGeneratedAt: normalizeInstant(m.get('archive_generated_at')),
        importedAt: normalizeInstant(m.get('imported_at')),
        importCount: importCount === undefined ? 0 : num(importCount, 'n'),
        timezone: timeZone,
        counts: { tweets: count('tweets'), likes: count('likes'), dmConversations: count('dm_conversations') },
        range: { first: toIsoOrNull(first), last: toIsoOrNull(last) },
      };
    },

    /** 取り込み履歴 (新しい順) */
    imports: (): ImportRecord[] =>
      all({ sql: `SELECT ${IMPORT_COLS} FROM imports ORDER BY id DESC`, params: [] }).map(toImportRecord),

    /** 同名・同サイズの ZIP の最新の取り込み記録 */
    latestImportOf: (fileName: string, fileSize: number): ImportRecord | null => {
      const r = get(
        `SELECT ${IMPORT_COLS} FROM imports WHERE file_name = ? AND file_size = ? ORDER BY id DESC LIMIT 1`,
        fileName,
        fileSize,
      );
      return r === undefined ? null : toImportRecord(r);
    },

    tweets: (f: TweetFilter): Page<Tweet> => {
      const rows = all(buildTweetQuery(f, maxGeneratedAt()));
      const page = toPage(rows, f.limit, (r) => r, (r) => encodeCursor(num(r, 'created_at'), str(r, 'id')));
      return { items: hydrate(page.items), nextCursor: page.nextCursor };
    },

    tweetDetail: (id: string): TweetDetail | null => {
      const row = get(`SELECT ${TWEET_COLS} FROM tweets t WHERE t.id = ?`, id);
      if (row === undefined) return null;
      const parentId = strOrNull(row, 'in_reply_to_status_id');
      const parentRow =
        parentId === null ? undefined : get(`SELECT ${TWEET_COLS} FROM tweets t WHERE t.id = ?`, parentId);
      const replyRows = all({
        sql: `SELECT ${TWEET_COLS} FROM tweets t WHERE t.in_reply_to_status_id = ? ORDER BY t.created_at ASC, t.id ASC LIMIT 500`,
        params: [id],
      });
      const rows = [row, ...(parentRow === undefined ? [] : [parentRow]), ...replyRows];
      const media = loadMedia(rows.map((r) => str(r, 'id')));
      const build = (r: Row): Tweet => toTweet(r, media.get(str(r, 'id')) ?? []);
      return {
        tweet: build(row),
        parent: parentRow === undefined ? null : build(parentRow),
        replies: replyRows.map(build),
      };
    },

    /** 設定タイムゾーンでの月別件数。月の境界 (UTC ms) を求め、インデックス上の範囲 COUNT で数える (DST 対応) */
    calendar: (): MonthCount[] => {
      const range = get('SELECT MIN(created_at) AS first, MAX(created_at) AS last FROM tweets');
      const first = range === undefined ? null : numOrNull(range, 'first');
      const last = range === undefined ? null : numOrNull(range, 'last');
      if (first === null || last === null) return [];
      const lastMonth = localMonth(last, timeZone);
      const boundary = (month: string): number => {
        const ms = zonedMidnightToUtc(`${month}-01`, timeZone);
        if (ms === null) throw new Error(`calendar: invalid month ${month}`);
        return ms;
      };
      const result: MonthCount[] = [];
      for (let month = localMonth(first, timeZone); month <= lastMonth; month = nextMonth(month)) {
        const r = get('SELECT COUNT(*) AS n FROM tweets WHERE created_at >= ? AND created_at < ?', boundary(month), boundary(nextMonth(month)));
        const n = r === undefined ? 0 : num(r, 'n');
        if (n > 0) result.push({ month, count: n });
      }
      return result;
    },

    likes: (terms: readonly string[], cursor: number | null, limit: number): Page<Like> => {
      const rows = all(buildLikesQuery(terms, cursor, limit));
      return toPage(
        rows,
        limit,
        (r): Like => {
          const tweetId = str(r, 'tweet_id');
          return {
            tweetId,
            text: str(r, 'full_text'),
            url: strOrNull(r, 'expanded_url') ?? `https://x.com/i/status/${tweetId}`,
            removedAt: toIsoOrNull(numOrNull(r, 'removed_at')),
          };
        },
        (r) => String(num(r, 'ord')),
      );
    },

    dmConversations: (): DmConversation[] =>
      all({
        sql: 'SELECT id, is_group, participants, last_at, message_count FROM dm_conversations ORDER BY last_at DESC, id DESC',
        params: [],
      }).map(toDmConversation),

    /** 会話が存在しなければ null */
    dmMessages: (conversationId: string, cursor: KeysetCursor | null, limit: number): Page<DmMessage> | null => {
      if (get('SELECT 1 AS x FROM dm_conversations WHERE id = ?', conversationId) === undefined) return null;
      const myId = myAccountId();
      const params: SQLInputValue[] = [conversationId];
      let cond = '';
      if (cursor !== null) {
        cond = ' AND (created_at > ? OR (created_at = ? AND id > ?))';
        params.push(cursor.createdAt, cursor.createdAt, cursor.id);
      }
      params.push(limit + 1);
      const rows = all({
        sql: `SELECT id, sender_id, created_at, text, media, reactions, ${removedAtExpr('dm_messages')} FROM dm_messages
              WHERE conversation_id = ?${cond} ORDER BY created_at ASC, id ASC LIMIT ?`,
        params,
      });
      return toPage(rows, limit, (r) => toDmMessage(r, myId), (r) => encodeCursor(num(r, 'created_at'), str(r, 'id')));
    },
  };
};
