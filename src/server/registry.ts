import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import type { AccountSummary } from '../shared/types.ts';
import { hasCurrentSchema, openDb } from '../db/open.ts';
import { accountDbPath, accountIdFromDbFileName, accountsDirOf, isAccountId, isStaleTmpName } from '../db/paths.ts';
import { removeDbFiles } from '../db/swap.ts';
import { createDbHolder, type DbHolder } from './db-holder.ts';
import { HttpError } from './http.ts';
import { createQueries, type Queries } from './queries.ts';

export type AccountHandle = {
  /** 空 DB (アカウント無し) のときは '' */
  readonly id: string;
  readonly holder: DbHolder;
  readonly queries: Queries;
};

export type Registry = {
  /** 取り込み済みアカウント (最後に取り込んだ順) */
  readonly list: () => readonly AccountSummary[];
  /** 既存アカウントのハンドル一覧 (空 DB は含まない) */
  readonly handles: () => readonly AccountHandle[];
  /**
   * `?account=` の値 → ハンドル。null/空なら既定アカウント (無ければ空 DB)。
   * 不正な形式は 400、存在しないアカウントは 404。
   */
  readonly resolve: (raw: string | null) => AccountHandle;
  readonly has: (id: string) => boolean;
  /** そのアカウントの DB を閉じて fn を実行し、成否に関わらず (ファイルがあれば) 開き直す。新規アカウントも登録される */
  readonly withClosed: <T>(id: string, fn: () => T) => T;
  /** そのアカウントの DB ファイルを削除する (ハンドルは閉じて忘れる) */
  readonly remove: (id: string) => void;
  readonly closeAll: () => void;
};

export type RegistryDeps = {
  readonly dbDir: string;
  readonly getTimeZone: () => string;
};

/** 現行スキーマか / 統計用インデックスがあるか */
const probe = (path: string): { current: boolean; hasStatsIndex: boolean } => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const idx = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'index' AND name = 'tweets_stats'").get();
    return { current: hasCurrentSchema(db), hasStatsIndex: idx !== undefined };
  } finally {
    db.close();
  }
};

/**
 * 起動時の DB 準備: 取り込み途中の一時ファイルを消し、旧スキーマ (v1) の DB は `.v1` に退避し、
 * 現行スキーマで足りない索引 (統計用) を補う。
 */
export const prepareAccountDbs = (dbDir: string): void => {
  const dir = accountsDirOf(dbDir);
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(dir)) {
    if (isStaleTmpName(name)) rmSync(join(dir, name), { force: true });
  }
  for (const name of readdirSync(dir)) {
    const id = accountIdFromDbFileName(name);
    if (id === null) continue;
    const path = accountDbPath(dbDir, id);
    const { current, hasStatsIndex } = probe(path);
    if (!current) {
      const backup = `${path}.v1`;
      if (existsSync(backup)) throw new Error(`旧スキーマの DB を退避できません (${backup} が既に存在します)`);
      for (const suffix of ['', '-wal', '-shm']) {
        if (existsSync(`${path}${suffix}`)) renameSync(`${path}${suffix}`, `${backup}${suffix}`);
      }
      console.warn(`[main] 旧スキーマの DB を ${backup} に退避しました。ZIP を取り込み直してください`);
    } else if (!hasStatsIndex) {
      // IF NOT EXISTS のスキーマを適用して索引を作る (既存データは変えない)
      const db = openDb(path);
      try {
        db.exec('PRAGMA journal_mode = DELETE;');
      } finally {
        db.close();
      }
      console.log(`[main] 統計用インデックスを追加しました: ${path}`);
    }
  }
};

const byLastImportedDesc = (a: AccountSummary, b: AccountSummary): number => {
  const ta = a.lastImportedAt === null ? -Infinity : Date.parse(a.lastImportedAt);
  const tb = b.lastImportedAt === null ? -Infinity : Date.parse(b.lastImportedAt);
  if (ta !== tb) return tb > ta ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

export const createRegistry = (deps: RegistryDeps): Registry => {
  const { dbDir, getTimeZone } = deps;
  const open = new Map<string, AccountHandle>();
  let summaries: AccountSummary[] | null = null;
  let emptyHandle: AccountHandle | null = null;

  const scanIds = (): string[] => {
    const dir = accountsDirOf(dbDir);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .map(accountIdFromDbFileName)
      .filter((id): id is string => id !== null);
  };

  /** ファイルがあれば読み取り専用ハンドルを (キャッシュして) 返す。無ければ null */
  const handleFor = (id: string): AccountHandle | null => {
    const hit = open.get(id);
    if (hit !== undefined) return hit;
    const path = accountDbPath(dbDir, id);
    if (!existsSync(path)) return null;
    const holder = createDbHolder(path);
    holder.reopen();
    const handle: AccountHandle = { id, holder, queries: createQueries(holder, id, getTimeZone) };
    open.set(id, handle);
    return handle;
  };

  const handles = (): AccountHandle[] =>
    scanIds().flatMap((id) => {
      const h = handleFor(id);
      return h === null ? [] : [h];
    });

  const list = (): readonly AccountSummary[] => {
    if (summaries !== null) return summaries;
    const built = handles()
      .flatMap((h) => {
        const s = h.queries.accountSummary();
        return s === null ? [] : [s];
      })
      .sort(byLastImportedDesc);
    summaries = built;
    return built;
  };

  /** アカウントが 1 つも無いときの応答用: メモリ上のスキーマだけの DB */
  const empty = (): AccountHandle => {
    if (emptyHandle !== null) return emptyHandle;
    const holder: DbHolder = (() => {
      const db = openDb(':memory:');
      return { path: ':memory:', get: () => db, reopen: () => undefined, close: () => db.close() };
    })();
    emptyHandle = { id: '', holder, queries: createQueries(holder, '', getTimeZone) };
    return emptyHandle;
  };

  const resolve = (raw: string | null): AccountHandle => {
    if (raw === null || raw === '') {
      const first = list()[0];
      const h = first === undefined ? null : handleFor(first.id);
      return h ?? empty();
    }
    if (!isAccountId(raw)) throw new HttpError(400, 'invalid account');
    const h = handleFor(raw);
    if (h === null) throw new HttpError(404, 'account not found');
    return h;
  };

  return {
    list,
    handles,
    resolve,
    has: (id) => isAccountId(id) && existsSync(accountDbPath(dbDir, id)),
    withClosed: (id, fn) => {
      open.get(id)?.holder.close();
      try {
        return fn();
      } finally {
        summaries = null;
        const path = accountDbPath(dbDir, id);
        const h = open.get(id);
        if (!existsSync(path)) open.delete(id);
        else if (h !== undefined) h.holder.reopen();
        else handleFor(id);
      }
    },
    remove: (id) => {
      open.get(id)?.holder.close();
      open.delete(id);
      const path = accountDbPath(dbDir, id);
      removeDbFiles(path);
      removeDbFiles(`${path}.tmp`);
      summaries = null;
    },
    closeAll: () => {
      for (const h of open.values()) h.holder.close();
      open.clear();
      emptyHandle?.holder.close();
      emptyHandle = null;
    },
  };
};
