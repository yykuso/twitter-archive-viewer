import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

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

/** TIMEZONE 環境変数 (未設定・空文字なら null) */
const envTimeZone = (): string | null => {
  const v = process.env['TIMEZONE'];
  return v === undefined || v.trim() === '' ? null : v.trim();
};

/** 未設定・空文字は未設定扱い */
const env = (name: string): string | undefined => {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
};

const envDbPath = env('DB_PATH');
const dbDir = env('DB_DIR') ?? (envDbPath === undefined ? '/data/db' : dirname(envDbPath));

/**
 * 環境変数から設定を読む。未設定なら /data 配下。
 * DB_DIR: DB 置き場 (アカウント別 SQLite は `<DB_DIR>/accounts/<id>.sqlite`, 設定は `<DB_DIR>/settings.json`)。
 * DB_PATH: 旧単一 DB のパス。後方互換のため移行元の探索にだけ使う (未設定なら `<DB_DIR>/tweets.sqlite`)。DB_DIR 未設定ならその親ディレクトリを DB_DIR とする。
 */
export const config = {
  dbDir,
  legacyDbPath: envDbPath ?? join(dbDir, 'tweets.sqlite'),
  mediaRoot: env('MEDIA_ROOT') ?? '/data/media',
  archiveDir: env('ARCHIVE_DIR') ?? '/data/archive',
  port: Number(process.env['PORT'] ?? '8080'),
  /** 環境変数 TIMEZONE (IANA 名)。未設定なら null */
  envTimeZone: envTimeZone(),
} as const;
