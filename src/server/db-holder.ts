import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../db/open.ts';

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
