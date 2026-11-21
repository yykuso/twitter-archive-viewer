import { join } from 'node:path';

/** Twitter の数値アカウント ID。パスに使う値は必ずこれで検証する */
export const ACCOUNT_ID_RE = /^[0-9]{1,25}$/;

export const isAccountId = (v: string): boolean => ACCOUNT_ID_RE.test(v);

export const assertAccountId = (v: string): string => {
  if (!isAccountId(v)) throw new Error(`invalid account id (expected 1-25 digits): ${JSON.stringify(v)}`);
  return v;
};

/** `<dbDir>/accounts` */
export const accountsDirOf = (dbDir: string): string => join(dbDir, 'accounts');

/** `<dbDir>/accounts/<accountId>.sqlite` */
export const accountDbPath = (dbDir: string, accountId: string): string =>
  join(accountsDirOf(dbDir), `${assertAccountId(accountId)}.sqlite`);

/** `<mediaRoot>/<accountId>` (ZIP の `data/...` はこの下に展開される) */
export const accountMediaDir = (mediaRoot: string, accountId: string): string =>
  join(mediaRoot, assertAccountId(accountId));

/** `<dbDir>/settings.json` */
export const settingsPathOf = (dbDir: string): string => join(dbDir, 'settings.json');

const ACCOUNT_DB_FILE_RE = /^([0-9]{1,25})\.sqlite$/;

/** ファイル名 `<id>.sqlite` からアカウント ID を取り出す (該当しなければ null) */
export const accountIdFromDbFileName = (name: string): string | null => ACCOUNT_DB_FILE_RE.exec(name)?.[1] ?? null;

const STALE_TMP_RE = /^[0-9]{1,25}\.sqlite\.tmp(-wal|-shm|-journal)?$/;

/** 取り込み途中で残った一時ファイル名か */
export const isStaleTmpName = (name: string): boolean => STALE_TMP_RE.test(name);
