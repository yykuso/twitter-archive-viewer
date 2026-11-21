import { existsSync, renameSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { createEmptyDb, hasCurrentSchema, openDb } from '../db/open.ts';
import { removeDbFiles, tmpPathFor } from '../db/swap.ts';

/** サーバーが使う読み取り専用ハンドルの入れ物。管理操作 (差し替え・リセット) で開き直せる */
export type DbHolder = {
  readonly path: string;
  /** 現在のハンドル。閉じている間 (差し替え中の失敗後など) は例外 */
  readonly get: () => DatabaseSync;
  /** 開き直す (開いていれば先に閉じる) */
  readonly reopen: () => void;
  readonly close: () => void;
};

export const createDbHolder = (path: string): DbHolder => {
  let db: DatabaseSync | null = null;
  const close = (): void => {
    if (db === null) return;
    const old = db;
    db = null;
    old.close();
  };
  return {
    path,
    get: () => {
      if (db === null) throw new Error(`database is not open: ${path}`);
      return db;
    },
    reopen: () => {
      close();
      db = openDb(path, { readOnly: true });
    },
    close,
  };
};

/**
 * 起動時の DB 準備: 取り込み途中の .tmp を消し、DB が無ければスキーマだけの空 DB を作る。
 * v1 の旧スキーマ DB は削除せず `.v1` に退避して作り直す。
 */
export const prepareDbFile = (path: string): void => {
  removeDbFiles(tmpPathFor(path));
  if (existsSync(path)) {
    const probe = openDb(path, { readOnly: true });
    let current: boolean;
    try {
      current = hasCurrentSchema(probe);
    } finally {
      probe.close();
    }
    if (current) return;
    const backup = `${path}.v1`;
    if (existsSync(backup)) throw new Error(`旧スキーマの DB を退避できません (${backup} が既に存在します)`);
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(`${path}${suffix}`)) renameSync(`${path}${suffix}`, `${backup}${suffix}`);
    }
    console.warn(`[main] 旧スキーマの DB を ${backup} に退避しました。ZIP を取り込み直してください`);
  }
  createEmptyDb(path);
};
