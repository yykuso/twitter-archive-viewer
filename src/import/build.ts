import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { closeAsSingleFile, hasCurrentSchema, openDb } from '../db/open.ts';
import { removeDbFiles } from '../db/swap.ts';
import { finalizeDb, mergeImport } from './merge.ts';
import type { MergeInput, MergeResult } from './merge.ts';

/**
 * 本番 DB (あれば) を VACUUM INTO で tmp に複製し、アーカイブをマージして単一ファイルの DB として閉じる。
 * 本番 DB は読み取り専用でしか開かない。失敗時は tmp を残さない。
 */
export const buildMergedDb = (livePath: string, tmpPath: string, input: MergeInput): MergeResult => {
  removeDbFiles(tmpPath);
  try {
    if (existsSync(livePath)) {
      const live = new DatabaseSync(livePath, { readOnly: true });
      try {
        if (!hasCurrentSchema(live)) {
          throw new Error(
            `既存の DB (${livePath}) は旧スキーマです。管理画面の「リセット」か DB ファイルの削除をしてから取り込んでください`,
          );
        }
        live.prepare('VACUUM INTO ?').run(tmpPath);
      } finally {
        live.close();
      }
    }
    const db = openDb(tmpPath);
    try {
      const result = mergeImport(db, input);
      finalizeDb(db);
      return result;
    } finally {
      closeAsSingleFile(db);
    }
  } catch (e) {
    removeDbFiles(tmpPath);
    throw e;
  }
};
