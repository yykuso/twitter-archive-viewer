import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { ImportStats, TableStats } from '../shared/types.ts';
import type { DmConversationRow, DmMessageRow, LikeRow, MediaRow, TweetWithMedia } from './transform.ts';

export type ImportData = {
  readonly tweets: readonly TweetWithMedia[];
  readonly likes: readonly LikeRow[];
  readonly dmConversations: readonly DmConversationRow[];
  readonly dmMessages: readonly DmMessageRow[];
  /** アカウント情報 (account_id, username, display_name, bio, avatar_file)。値が null のキーは削除 */
  readonly meta: Readonly<Record<string, string | null>>;
};

export type MergeInput = {
  readonly data: ImportData;
  /** manifest の archiveInfo.generationDate (Unix ms) = G */
  readonly generatedAt: number;
  readonly fileName: string;
  readonly fileSize: number;
  /** Unix ms */
  readonly startedAt: number;
  /** Unix ms。imported_at / imports.finished_at に使う */
  readonly now: number;
};

export type MergeResult = { readonly importId: number; readonly stats: ImportStats };

// ---- 純粋なマージ規則 -------------------------------------------------------

export type RowPlan = 'insert' | 'overwrite' | 'touch';

/** 既存行の data_from (無ければ null) とアーカイブ生成日時 G から、その行をどう扱うかを決める */
export const planRow = (existingDataFrom: number | null, generatedAt: number): RowPlan => {
  if (existingDataFrom === null) return 'insert';
  return generatedAt >= existingDataFrom ? 'overwrite' : 'touch';
};

export const mergeSeen = (
  existing: { readonly firstSeenAt: number; readonly lastSeenAt: number },
  generatedAt: number,
): { readonly firstSeenAt: number; readonly lastSeenAt: number } => ({
  firstSeenAt: Math.min(existing.firstSeenAt, generatedAt),
  lastSeenAt: Math.max(existing.lastSeenAt, generatedAt),
});

const sameValues = (a: readonly unknown[], b: readonly unknown[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

const bool = (b: boolean): number => (b ? 1 : 0);

// ---- テーブル共通のマージ処理 ------------------------------------------------

type TableSpec<R> = {
  readonly table: string;
  readonly keyCol: string;
  /** 内容列 (valuesOf の並びと一致させる) */
  readonly contentCols: readonly string[];
  readonly keyOf: (r: R) => string;
  readonly valuesOf: (r: R) => SQLInputValue[];
  /** 子テーブルなど内容列以外の差分 (ツイートのメディア) */
  readonly child?: {
    readonly differs: (r: R) => boolean;
    readonly replace: (r: R) => void;
  };
};

const num = (v: unknown, what: string): number => {
  if (typeof v !== 'number') throw new Error(`${what}: 数値を期待しましたが ${typeof v} でした`);
  return v;
};

/** 1 テーブル分のマージ。重複キーは後勝ちで 1 件にまとめる */
const mergeTable = <R>(db: DatabaseSync, spec: TableSpec<R>, rows: readonly R[], g: number): TableStats => {
  const { table, keyCol, contentCols } = spec;
  const select = db.prepare(
    `SELECT ${contentCols.join(', ')}, first_seen_at, last_seen_at, data_from FROM ${table} WHERE ${keyCol} = ?`,
  );
  const insert = db.prepare(
    `INSERT INTO ${table} (${keyCol}, ${contentCols.join(', ')}, first_seen_at, last_seen_at, data_from)
     VALUES (${['?', ...contentCols.map(() => '?'), '?', '?', '?'].join(', ')})`,
  );
  const overwrite = db.prepare(
    `UPDATE ${table} SET ${contentCols.map((c) => `${c} = ?`).join(', ')},
       first_seen_at = ?, last_seen_at = ?, data_from = ? WHERE ${keyCol} = ?`,
  );
  const touch = db.prepare(`UPDATE ${table} SET first_seen_at = ?, last_seen_at = ? WHERE ${keyCol} = ?`);

  const unique = new Map(rows.map((r) => [spec.keyOf(r), r] as const));
  let added = 0;
  let updated = 0;
  for (const [key, row] of unique) {
    const values = spec.valuesOf(row);
    const existing = select.get(key);
    const plan = planRow(existing === undefined ? null : num(existing['data_from'], `${table}.data_from`), g);
    if (existing === undefined || plan === 'insert') {
      insert.run(key, ...values, g, g, g);
      spec.child?.replace(row);
      added += 1;
      continue;
    }
    const seen = mergeSeen(
      {
        firstSeenAt: num(existing['first_seen_at'], `${table}.first_seen_at`),
        lastSeenAt: num(existing['last_seen_at'], `${table}.last_seen_at`),
      },
      g,
    );
    if (plan === 'touch') {
      touch.run(seen.firstSeenAt, seen.lastSeenAt, key);
      continue;
    }
    const before = contentCols.map((c) => existing[c]);
    const childChanged = spec.child?.differs(row) ?? false;
    if (!sameValues(before, values) || childChanged) updated += 1;
    overwrite.run(...values, seen.firstSeenAt, seen.lastSeenAt, g, key);
    if (childChanged) spec.child?.replace(row);
  }
  return { added, updated, seen: unique.size };
};

const tweetSpec = (db: DatabaseSync): TableSpec<TweetWithMedia> => {
  const selectMedia = db.prepare('SELECT idx, type, file, width, height FROM media WHERE tweet_id = ? ORDER BY idx');
  const deleteMedia = db.prepare('DELETE FROM media WHERE tweet_id = ?');
  const insertMedia = db.prepare('INSERT INTO media (tweet_id, idx, type, file, width, height) VALUES (?, ?, ?, ?, ?, ?)');
  const mediaTuple = (m: Pick<MediaRow, 'idx' | 'type' | 'file' | 'width' | 'height'>): string =>
    JSON.stringify([m.idx, m.type, m.file, m.width, m.height]);
  return {
    table: 'tweets',
    keyCol: 'id',
    contentCols: [
      'created_at', 'text', 'lang', 'source', 'in_reply_to_status_id', 'in_reply_to_screen_name',
      'is_retweet', 'is_reply', 'has_media', 'favorite_count', 'retweet_count', 'deleted_at',
    ],
    keyOf: (r) => r.tweet.id,
    valuesOf: ({ tweet: t }) => [
      t.createdAt, t.text, t.lang, t.source, t.inReplyToStatusId, t.inReplyToScreenName,
      bool(t.isRetweet), bool(t.isReply), bool(t.hasMedia), t.favoriteCount, t.retweetCount, t.deletedAt,
    ],
    child: {
      differs: (r) => {
        const old = selectMedia.all(r.tweet.id).map((m) =>
          JSON.stringify([m['idx'], m['type'], m['file'], m['width'], m['height']]),
        );
        return JSON.stringify(old) !== JSON.stringify(r.media.map(mediaTuple));
      },
      replace: (r) => {
        deleteMedia.run(r.tweet.id);
        for (const m of r.media) insertMedia.run(m.tweetId, m.idx, m.type, m.file, m.width, m.height);
      },
    },
  };
};

const likeSpec: TableSpec<LikeRow> = {
  table: 'likes',
  keyCol: 'tweet_id',
  contentCols: ['full_text', 'expanded_url', 'ord'],
  keyOf: (r) => r.tweetId,
  valuesOf: (r) => [r.fullText, r.expandedUrl, r.ord],
};

const dmMessageSpec: TableSpec<DmMessageRow> = {
  table: 'dm_messages',
  keyCol: 'id',
  contentCols: ['conversation_id', 'sender_id', 'created_at', 'text', 'media', 'reactions'],
  keyOf: (r) => r.id,
  valuesOf: (r) => [r.conversationId, r.senderId, r.createdAt, r.text, JSON.stringify(r.media), JSON.stringify(r.reactions)],
};

// ---- 会話・meta --------------------------------------------------------------

/** 会話の is_group / participants を更新する。last_at / message_count は後で再集計する */
const mergeConversations = (
  db: DatabaseSync,
  convs: readonly DmConversationRow[],
  g: number,
  previousMaxGenerated: number | null,
): void => {
  const insert = db.prepare(
    'INSERT INTO dm_conversations (id, is_group, participants, last_at, message_count) VALUES (?, ?, ?, 0, 0)',
  );
  const update = db.prepare('UPDATE dm_conversations SET is_group = ?, participants = ? WHERE id = ?');
  const exists = db.prepare('SELECT 1 AS x FROM dm_conversations WHERE id = ?');
  const overwriteAllowed = previousMaxGenerated === null || g >= previousMaxGenerated;
  for (const c of new Map(convs.map((c) => [c.id, c] as const)).values()) {
    const participants = JSON.stringify(c.participants);
    if (exists.get(c.id) === undefined) insert.run(c.id, bool(c.isGroup), participants);
    else if (overwriteAllowed) update.run(bool(c.isGroup), participants, c.id);
  }
  db.exec(`
    UPDATE dm_conversations SET
      last_at = COALESCE((SELECT MAX(created_at) FROM dm_messages m WHERE m.conversation_id = dm_conversations.id), 0),
      message_count = (SELECT COUNT(*) FROM dm_messages m WHERE m.conversation_id = dm_conversations.id)`);
};

const writeMeta = (db: DatabaseSync, entries: Readonly<Record<string, string | null>>): void => {
  const upsert = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const remove = db.prepare('DELETE FROM meta WHERE key = ?');
  for (const [key, value] of Object.entries(entries)) {
    if (value === null) remove.run(key);
    else upsert.run(key, value);
  }
};

const scalar = (db: DatabaseSync, sql: string, ...params: SQLInputValue[]): number | null => {
  const row = db.prepare(sql).get(...params);
  const v = row === undefined ? null : Object.values(row)[0];
  if (v === null || v === undefined) return null;
  return num(v, sql);
};

const countRemoved = (db: DatabaseSync, table: string, maxGenerated: number): number =>
  scalar(db, `SELECT COUNT(*) FROM ${table} WHERE last_seen_at < ?`, maxGenerated) ?? 0;

// ---- エントリポイント ---------------------------------------------------------

/**
 * アーカイブ 1 つを既存 DB にマージする (1 トランザクション)。
 * スキーマ適用済みの DB を渡すこと。FTS 再構築まで行う (ANALYZE は呼び出し側 = finalizeDb)。
 */
export const mergeImport = (db: DatabaseSync, input: MergeInput): MergeResult => {
  const g = input.generatedAt;
  db.exec('BEGIN');
  try {
    const previousMax = scalar(db, 'SELECT MAX(generated_at) FROM imports');
    const maxGenerated = Math.max(previousMax ?? g, g);

    const tweets = mergeTable(db, tweetSpec(db), input.data.tweets, g);
    const likes = mergeTable(db, likeSpec, input.data.likes, g);
    const dmMessages = mergeTable(db, dmMessageSpec, input.data.dmMessages, g);
    mergeConversations(db, input.data.dmConversations, g, previousMax);

    if (previousMax === null || g >= previousMax) writeMeta(db, input.data.meta);
    writeMeta(db, {
      archive_generated_at: new Date(maxGenerated).toISOString(),
      imported_at: new Date(input.now).toISOString(),
    });

    db.exec("INSERT INTO tweets_fts(tweets_fts) VALUES('rebuild')");

    // imports 行を入れる前に最大値を決めているので、removed は「この取り込み後」の状態
    const stats: ImportStats = {
      tweets,
      likes,
      dmMessages,
      removed: {
        tweets: countRemoved(db, 'tweets', maxGenerated),
        likes: countRemoved(db, 'likes', maxGenerated),
        dmMessages: countRemoved(db, 'dm_messages', maxGenerated),
      },
      mediaFiles: 0,
    };
    const inserted = db
      .prepare(
        'INSERT INTO imports (file_name, file_size, generated_at, started_at, finished_at, stats) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(input.fileName, input.fileSize, g, input.startedAt, input.now, JSON.stringify(stats));
    db.exec('COMMIT');
    return { importId: Number(inserted.lastInsertRowid), stats };
  } catch (e) {
    db.exec('ROLLBACK');
    throw new Error(`マージに失敗しました (${input.fileName}): ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
};

/** マージ後の仕上げ (統計情報の更新) */
export const finalizeDb = (db: DatabaseSync): void => {
  db.exec('ANALYZE');
};

/** imports 行の stats.mediaFiles を更新する */
export const setImportMediaFiles = (db: DatabaseSync, importId: number, mediaFiles: number): ImportStats => {
  const row = db.prepare('SELECT stats FROM imports WHERE id = ?').get(importId);
  const raw = row?.['stats'];
  if (typeof raw !== 'string') throw new Error(`imports.id=${importId} が見つかりません`);
  const current = JSON.parse(raw) as ImportStats;
  const next: ImportStats = { ...current, mediaFiles };
  db.prepare('UPDATE imports SET stats = ? WHERE id = ?').run(JSON.stringify(next), importId);
  return next;
};

export type TableCounts = Readonly<Record<'tweets' | 'media' | 'likes' | 'dm_conversations' | 'dm_messages' | 'imports', number>>;

export const countRows = (db: DatabaseSync): TableCounts => {
  const count = (table: string): number => scalar(db, `SELECT COUNT(*) FROM ${table}`) ?? 0;
  return {
    tweets: count('tweets'),
    media: count('media'),
    likes: count('likes'),
    dm_conversations: count('dm_conversations'),
    dm_messages: count('dm_messages'),
    imports: count('imports'),
  };
};
