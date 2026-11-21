import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { hasCurrentSchema } from './open.ts';
import { accountDbPath, accountIdFromDbFileName, accountMediaDir, accountsDirOf, isAccountId } from './paths.ts';
import { removeDbFiles } from './swap.ts';

export type LegacyPaths = {
  /** 旧単一 DB のパス */
  readonly legacyDbPath: string;
  readonly dbDir: string;
  readonly mediaRoot: string;
};

const SUFFIXES = ['', '-wal', '-shm'] as const;

/** 旧 DB の meta.account_id を読む。meta が空なら null */
const readLegacyAccountId = (path: string): string | null => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'account_id'").get();
    const v = row?.['value'];
    return typeof v === 'string' && v !== '' ? v : null;
  } finally {
    db.close();
  }
};

const isCurrentSchema = (path: string): boolean => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return hasCurrentSchema(db);
  } finally {
    db.close();
  }
};

const moveDbFiles = (from: string, to: string): void => {
  for (const s of SUFFIXES) {
    if (existsSync(`${from}${s}`)) renameSync(`${from}${s}`, `${to}${s}`);
  }
};

const moveMedia = (mediaRoot: string, accountId: string): void => {
  const legacy = join(mediaRoot, 'data');
  const target = accountMediaDir(mediaRoot, accountId);
  if (!existsSync(legacy)) return;
  if (existsSync(target)) {
    console.warn(`[migrate] ${legacy} は旧レイアウトのメディアですが ${target} が既に存在するため移動しません。手動で整理してください`);
    return;
  }
  mkdirSync(target, { recursive: true });
  try {
    renameSync(legacy, join(target, 'data'));
  } catch (e) {
    const code = e instanceof Error && 'code' in e ? String(e.code) : '';
    if (code === 'EXDEV') {
      throw new Error(
        `メディアの移動に失敗しました (別のファイルシステムをまたぐため rename できません): ${legacy} → ${join(target, 'data')}。` +
          `同じボリューム上に置くか、手動で移動してください`,
        { cause: e },
      );
    }
    throw e;
  }
  console.log(`[migrate] メディアを移動しました: ${legacy} → ${join(target, 'data')}`);
};

/** accounts/ 内のアカウント ID 一覧 */
const existingAccountIds = (dbDir: string): string[] => {
  const dir = accountsDirOf(dbDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map(accountIdFromDbFileName)
    .filter((id): id is string => id !== null);
};

/**
 * 旧レイアウト (単一 DB `tweets.sqlite` + `media/data`) をアカウント別レイアウトへ移行する。冪等。
 * - DB: meta.account_id を読み `accounts/<id>.sqlite` へ移動 (移動先が既にあればエラー。上書きしない)。
 *   account_id が無い (空の) DB は `.empty-backup` に退避。旧スキーマ (v1) の DB は `.v1` に退避。
 * - メディア: `<media>/data` → `<media>/<id>/data` (同一ファイルシステムの rename)。
 */
export const migrateLegacyLayout = (paths: LegacyPaths): void => {
  const { legacyDbPath, dbDir, mediaRoot } = paths;
  removeDbFiles(`${legacyDbPath}.tmp`);
  let accountId: string | null = null;

  if (existsSync(legacyDbPath)) {
    if (!isCurrentSchema(legacyDbPath)) {
      const backup = `${legacyDbPath}.v1`;
      if (existsSync(backup)) throw new Error(`旧スキーマの DB を退避できません (${backup} が既に存在します)`);
      moveDbFiles(legacyDbPath, backup);
      console.warn(`[migrate] 旧スキーマの DB を ${backup} に退避しました。ZIP を取り込み直してください`);
    } else {
      accountId = readLegacyAccountId(legacyDbPath);
      if (accountId === null) {
        const backup = `${legacyDbPath}.empty-backup`;
        if (existsSync(backup)) throw new Error(`空の旧 DB を退避できません (${backup} が既に存在します)`);
        moveDbFiles(legacyDbPath, backup);
        console.log(`[migrate] アカウント情報の無い空の旧 DB を ${backup} に退避しました`);
      } else {
        if (!isAccountId(accountId)) {
          throw new Error(`旧 DB の account_id が数値 ID ではありません: ${JSON.stringify(accountId)} (${legacyDbPath})`);
        }
        const target = accountDbPath(dbDir, accountId);
        if (existsSync(target)) {
          throw new Error(
            `旧 DB (${legacyDbPath}) の移行先 ${target} が既に存在します。上書きしないため起動を中止します。どちらかを退避してください`,
          );
        }
        mkdirSync(accountsDirOf(dbDir), { recursive: true });
        moveDbFiles(legacyDbPath, target);
        console.log(`[migrate] DB を移動しました: ${legacyDbPath} → ${target}`);
      }
    }
  }

  // DB 移動後にメディア移動が失敗しても、次回起動で再試行できるよう、アカウントが 1 つだけならそれを移行先とみなす
  if (accountId === null && existsSync(join(mediaRoot, 'data'))) {
    const ids = existingAccountIds(dbDir);
    if (ids.length === 1) accountId = ids[0] ?? null;
  }
  if (accountId !== null) moveMedia(mediaRoot, accountId);
  else if (existsSync(join(mediaRoot, 'data'))) {
    console.warn(`[migrate] ${join(mediaRoot, 'data')} (旧レイアウトのメディア) の移行先アカウントを特定できないため移動しません`);
  }
};
