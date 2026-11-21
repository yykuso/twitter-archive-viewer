import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

const schemaPath = new URL('./schema.sql', import.meta.url);

export type OpenOptions = { readonly readOnly?: boolean };

/** DB を開き、書き込みモードならスキーマを適用する */
export const openDb = (path: string, options: OpenOptions = {}): DatabaseSync => {
  if (options.readOnly === true) {
    const db = new DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA query_only = ON;');
    return db;
  }
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(readFileSync(schemaPath, 'utf8'));
  return db;
};

/** 書き込みで開いた DB を -wal なしの単一ファイルにして閉じる (リネーム・読み取り専用オープン向け) */
export const closeAsSingleFile = (db: DatabaseSync): void => {
  try {
    db.exec('PRAGMA journal_mode = DELETE;');
  } finally {
    db.close();
  }
};

/** スキーマだけの空 DB を作る (既存ファイルがあればスキーマ適用のみ) */
export const createEmptyDb = (path: string): void => {
  closeAsSingleFile(openDb(path));
};

/** first_seen_at / data_from 列を持つ現行スキーマか (v1 の DB は false) */
export const hasCurrentSchema = (db: DatabaseSync): boolean => {
  const cols = db.prepare("SELECT name FROM pragma_table_info('tweets')").all();
  const names = new Set(cols.map((c) => c['name']));
  return names.has('data_from') && names.has('first_seen_at') && names.has('last_seen_at');
};

/** 環境変数から設定を読む。未設定なら /data 配下 */
export const config = {
  dbPath: process.env['DB_PATH'] ?? '/data/db/tweets.sqlite',
  mediaRoot: process.env['MEDIA_ROOT'] ?? '/data/media',
  archiveDir: process.env['ARCHIVE_DIR'] ?? '/data/archive',
  port: Number(process.env['PORT'] ?? '8080'),
  /** 表示・日付絞り込み・月別集計に使うタイムゾーン (IANA 名) */
  timeZone: process.env['TIMEZONE'] ?? 'UTC',
} as const;
