-- 日時はすべて UTC の Unix ミリ秒 (INTEGER)
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tweets (
  rowid                  INTEGER PRIMARY KEY,
  id                     TEXT NOT NULL UNIQUE,
  created_at             INTEGER NOT NULL,
  text                   TEXT NOT NULL,      -- t.co展開済み・メディアURL除去済み・HTML実体参照デコード済み
  lang                   TEXT,
  source                 TEXT,               -- クライアント名 (タグ除去済み)
  in_reply_to_status_id  TEXT,
  in_reply_to_screen_name TEXT,
  is_retweet             INTEGER NOT NULL DEFAULT 0,
  is_reply               INTEGER NOT NULL DEFAULT 0,
  has_media              INTEGER NOT NULL DEFAULT 0,
  favorite_count         INTEGER NOT NULL DEFAULT 0,
  retweet_count          INTEGER NOT NULL DEFAULT 0,
  deleted_at             INTEGER,            -- deleted-tweets.js 由来のみ値あり
  first_seen_at  INTEGER NOT NULL, -- このデータを含んでいた最古のアーカイブ生成日時
  last_seen_at   INTEGER NOT NULL, -- このデータを含んでいた最新のアーカイブ生成日時
  data_from      INTEGER NOT NULL  -- 内容列の値を取ったアーカイブの生成日時 (新しいものだけで上書き)
);
CREATE INDEX IF NOT EXISTS tweets_created ON tweets (created_at, id);
-- 統計用カバリングインデックス (テーブル本体を読まずに 1 回の走査で集計する)
CREATE INDEX IF NOT EXISTS tweets_stats ON tweets (created_at, is_reply, is_retweet, has_media, deleted_at);
CREATE INDEX IF NOT EXISTS tweets_reply_to ON tweets (in_reply_to_status_id);

CREATE TABLE IF NOT EXISTS media (
  tweet_id TEXT NOT NULL,
  idx      INTEGER NOT NULL,
  type     TEXT NOT NULL,                    -- photo | video | animated_gif
  file     TEXT,                             -- メディアルートからの相対パス。見つからなければ NULL
  width    INTEGER,
  height   INTEGER,
  PRIMARY KEY (tweet_id, idx)
);

CREATE VIRTUAL TABLE IF NOT EXISTS tweets_fts USING fts5 (
  text,
  content = 'tweets',
  content_rowid = 'rowid',
  tokenize = 'trigram'
);

CREATE TABLE IF NOT EXISTS likes (
  tweet_id     TEXT PRIMARY KEY,
  full_text    TEXT NOT NULL,
  expanded_url TEXT,
  ord          INTEGER NOT NULL,             -- data_from のアーカイブの like.js 内の順序 (0 = 最新)
  first_seen_at  INTEGER NOT NULL, -- このデータを含んでいた最古のアーカイブ生成日時
  last_seen_at   INTEGER NOT NULL, -- このデータを含んでいた最新のアーカイブ生成日時
  data_from      INTEGER NOT NULL  -- 内容列の値を取ったアーカイブの生成日時 (新しいものだけで上書き)
);

-- dm_conversations は取り込み後に dm_messages から再集計する
CREATE TABLE IF NOT EXISTS dm_conversations (
  id            TEXT PRIMARY KEY,
  is_group      INTEGER NOT NULL,
  participants  TEXT NOT NULL,               -- JSON: string[] (ユーザーID)
  last_at       INTEGER NOT NULL,
  message_count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS dm_messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  sender_id       TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  text            TEXT NOT NULL,
  media           TEXT NOT NULL DEFAULT '[]', -- JSON: string[] (メディアルートからの相対パス)
  reactions       TEXT NOT NULL DEFAULT '[]', -- JSON: {senderId, reactionKey}[]
  first_seen_at  INTEGER NOT NULL, -- このデータを含んでいた最古のアーカイブ生成日時
  last_seen_at   INTEGER NOT NULL, -- このデータを含んでいた最新のアーカイブ生成日時
  data_from      INTEGER NOT NULL  -- 内容列の値を取ったアーカイブの生成日時 (新しいものだけで上書き)
);
CREATE INDEX IF NOT EXISTS dm_messages_conv ON dm_messages (conversation_id, created_at, id);

-- 「消失」= last_seen_at < 取り込み済みアーカイブの最大 generated_at。
-- 消失したアーカイブ日 = last_seen_at より後で最小の generated_at。
CREATE TABLE IF NOT EXISTS imports (
  id           INTEGER PRIMARY KEY,
  file_name    TEXT NOT NULL,
  file_size    INTEGER NOT NULL,
  generated_at INTEGER NOT NULL,             -- manifest の archiveInfo.generationDate
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER NOT NULL,
  stats        TEXT NOT NULL                 -- JSON: ImportStats
);
CREATE INDEX IF NOT EXISTS imports_generated ON imports (generated_at);
CREATE INDEX IF NOT EXISTS tweets_last_seen ON tweets (last_seen_at);
