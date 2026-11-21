import { existsSync, renameSync, rmSync } from 'node:fs';

/** ビルド途中 DB の既定パス */
export const tmpPathFor = (dbPath: string): string => `${dbPath}.tmp`;

/** 指定 DB とその付随ファイル (-wal/-shm/-journal) を削除する (無ければ何もしない) */
export const removeDbFiles = (path: string): void => {
  for (const p of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
    rmSync(p, { force: true });
  }
};

/**
 * tmp を本番 DB に置き換える。呼び出し側は事前に本番 DB のハンドルを全て閉じること。
 * 古い -wal/-shm を残すと新しい DB に誤適用されるので先に消す。
 */
export const swapDatabase = (dbPath: string, tmpPath: string): void => {
  if (!existsSync(tmpPath)) throw new Error(`差し替える DB が見つかりません: ${tmpPath}`);
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  renameSync(tmpPath, dbPath);
};
