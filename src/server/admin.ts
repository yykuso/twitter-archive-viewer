import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { closeAsSingleFile, openDb } from '../db/open.ts';
import { accountDbPath, accountMediaDir, isAccountId } from '../db/paths.ts';
import { removeDbFiles, swapDatabase, tmpPathFor } from '../db/swap.ts';
import { countMediaEntries, mediaPatterns } from '../import/media.ts';
import { setImportMediaFiles } from '../import/merge.ts';
import { extractMedia, isExtractedLine, listEntries } from '../import/zip.ts';
import type { ArchiveFile, ImportJob, ImportRecord, ImportRequest, ImportStage, ImportStats, ResetRequest } from '../shared/types.ts';
import { HttpError } from './http.ts';
import type { Registry } from './registry.ts';

const CLI_PATH = fileURLToPath(new URL('../import/cli.ts', import.meta.url));
const STDERR_KEEP = 30;

export type AdminDeps = {
  readonly registry: Registry;
  /** `<dbDir>` (アカウント別 DB は `<dbDir>/accounts/<id>.sqlite`) */
  readonly dbDir: string;
  readonly archiveDir: string;
  readonly mediaRoot: string;
};

export type Admin = {
  readonly archives: () => Promise<ArchiveFile[]>;
  readonly status: () => ImportJob | null;
  readonly startImport: (body: unknown) => ImportJob;
  readonly reset: (body: unknown) => void;
  /** シャットダウン時に実行中の子プロセスを止め、tmp を消す */
  readonly abort: () => void;
};

// ---- リクエスト検証 (pure) ----------------------------------------------------

const asRecord = (body: unknown): Record<string, unknown> => {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'request body must be a JSON object');
  }
  return body as Record<string, unknown>;
};

/** ディレクトリ区切りや `..` を含まない、.zip で終わるファイル名か */
export const isPlainZipName = (name: string): boolean =>
  name !== '' &&
  name.length <= 255 &&
  !/[/\\\0]/.test(name) &&
  !name.includes('..') &&
  /\.zip$/i.test(name);

export const parseImportRequest = (body: unknown): ImportRequest => {
  const o = asRecord(body);
  const fileName = o['fileName'];
  if (typeof fileName !== 'string' || !isPlainZipName(fileName)) {
    throw new HttpError(400, 'fileName must be a plain .zip file name');
  }
  const skipMedia = o['skipMedia'];
  if (skipMedia !== undefined && typeof skipMedia !== 'boolean') throw new HttpError(400, 'skipMedia must be a boolean');
  return skipMedia === undefined ? { fileName } : { fileName, skipMedia };
};

export const parseResetRequest = (body: unknown): ResetRequest => {
  const o = asRecord(body);
  if (o['confirm'] !== 'RESET') throw new HttpError(400, 'confirm must be "RESET"');
  const accountId = o['accountId'];
  if (typeof accountId !== 'string' || !isAccountId(accountId)) throw new HttpError(400, 'accountId must be a numeric account id');
  return { confirm: 'RESET', accountId };
};

// ---- ジョブ状態 (pure) ---------------------------------------------------------

const isRunning = (job: ImportJob | null): boolean => job !== null && job.stage !== 'done' && job.stage !== 'failed';

const newJob = (fileName: string): ImportJob => ({
  id: randomUUID(),
  fileName,
  account: null,
  stage: 'queued',
  progress: null,
  message: null,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  error: null,
  stats: null,
});

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 子プロセスの stdout の 1 行 (JSON 行) の解釈結果 */
type CliEvent =
  | {
      readonly kind: 'stage';
      readonly stage: 'reading' | 'writing';
      readonly message: string | null;
      readonly account: { readonly id: string; readonly username: string } | null;
    }
  | { readonly kind: 'built'; readonly accountId: string; readonly importId: number; readonly stats: ImportStats }
  | { readonly kind: 'other' };

export const parseCliLine = (line: string): CliEvent => {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return { kind: 'other' };
  }
  if (typeof v !== 'object' || v === null) return { kind: 'other' };
  const o = v as Record<string, unknown>;
  if (o['stage'] === 'reading' || o['stage'] === 'writing') {
    const acc = o['account'];
    const account =
      typeof acc === 'object' && acc !== null && typeof (acc as Record<string, unknown>)['id'] === 'string' && typeof (acc as Record<string, unknown>)['username'] === 'string'
        ? { id: (acc as { id: string }).id, username: (acc as { username: string }).username }
        : null;
    const message = typeof o['message'] === 'string' ? o['message'] : null;
    if (message !== null || account !== null) return { kind: 'stage', stage: o['stage'], message, account };
  }
  if (
    o['stage'] === 'built' &&
    typeof o['accountId'] === 'string' &&
    typeof o['importId'] === 'number' &&
    typeof o['stats'] === 'object' &&
    o['stats'] !== null
  ) {
    return { kind: 'built', accountId: o['accountId'], importId: o['importId'], stats: o['stats'] as ImportStats };
  }
  return { kind: 'other' };
};

// ---- 本体 ----------------------------------------------------------------------

export const createAdmin = (deps: AdminDeps): Admin => {
  const { registry, dbDir, archiveDir, mediaRoot } = deps;
  let job: ImportJob | null = null;
  let child: ChildProcess | null = null;

  const patch = (id: string, p: Partial<ImportJob>): void => {
    if (job !== null && job.id === id) job = { ...job, ...p };
  };
  const setStage = (id: string, stage: ImportStage, message: string | null, progress: ImportJob['progress'] = null): void =>
    patch(id, { stage, message, progress });

  /** import 子プロセスを実行し、built イベントを返す */
  const runCli = (j: ImportJob, zipPath: string): Promise<{ accountId: string; importId: number; stats: ImportStats }> =>
    new Promise((resolve, reject) => {
      const proc = spawn(
        process.execPath,
        ['--disable-warning=ExperimentalWarning', CLI_PATH, zipPath, '--build-only', '--progress-json'],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      child = proc;
      const errLines: string[] = [];
      let built: { accountId: string; importId: number; stats: ImportStats } | null = null;
      createInterface({ input: proc.stdout }).on('line', (line) => {
        const ev = parseCliLine(line);
        if (ev.kind === 'stage') {
          if (ev.account !== null) patch(j.id, { account: ev.account });
          if (ev.message !== null) setStage(j.id, ev.stage, ev.message);
        } else if (ev.kind === 'built') built = { accountId: ev.accountId, importId: ev.importId, stats: ev.stats };
      });
      createInterface({ input: proc.stderr }).on('line', (line) => {
        if (line.trim() === '') return;
        errLines.push(line);
        if (errLines.length > STDERR_KEEP) errLines.shift();
        patch(j.id, { message: line });
      });
      proc.on('error', (e) => reject(new Error(`取り込みプロセスを起動できませんでした: ${e.message}`)));
      proc.on('close', (code, signal) => {
        child = null;
        if (code === 0 && built !== null) return resolve(built);
        const detail = errLines.slice(-8).join('\n');
        reject(
          new Error(
            code === 0
              ? `取り込みプロセスが結果を返さずに終了しました\n${detail}`
              : `取り込みプロセスが失敗しました (${signal ?? `code ${code}`}): ${detail}`,
          ),
        );
      });
    });

  const extractMediaWithProgress = async (j: ImportJob, zipPath: string, accountId: string): Promise<number> => {
    const entries = await listEntries(zipPath);
    const total = countMediaEntries(entries);
    setStage(j.id, 'media', 'メディアを展開中', { done: 0, total });
    let done = 0;
    const extracted = await extractMedia(zipPath, mediaPatterns(entries), accountMediaDir(mediaRoot, accountId), (line) => {
      if (!isExtractedLine(line) || !line.includes('data/')) return;
      done += 1;
      patch(j.id, { progress: { done: Math.min(done, total), total } });
    });
    patch(j.id, { progress: { done: total, total } });
    return extracted;
  };

  const run = async (j: ImportJob, req: ImportRequest): Promise<void> => {
    const zipPath = join(archiveDir, req.fileName);
    let tmpPath: string | null = null;
    try {
      setStage(j.id, 'reading', 'ZIP を読み込み中');
      const built = await runCli(j, zipPath);
      const id = built.accountId;
      if (!isAccountId(id)) throw new Error(`取り込みプロセスが不正なアカウント ID を返しました: ${JSON.stringify(id)}`);
      const dbPath = accountDbPath(dbDir, id);
      const tmp = tmpPathFor(dbPath);
      tmpPath = tmp;

      setStage(j.id, 'swapping', 'DB を差し替え中');
      registry.withClosed(id, () => swapDatabase(dbPath, tmp));
      tmpPath = null;
      patch(j.id, { stats: built.stats });

      if (req.skipMedia !== true) {
        const mediaFiles = await extractMediaWithProgress(j, zipPath, id);
        const stats = registry.withClosed(id, () => {
          const db = openDb(dbPath);
          try {
            return setImportMediaFiles(db, built.importId, mediaFiles);
          } finally {
            closeAsSingleFile(db);
          }
        });
        patch(j.id, { stats });
      }
      patch(j.id, { stage: 'done', message: null, finishedAt: new Date().toISOString() });
    } catch (e) {
      const known = job?.id === j.id ? job.account : null;
      const stale = tmpPath ?? (known === null ? null : tmpPathFor(accountDbPath(dbDir, known.id)));
      if (stale !== null) removeDbFiles(stale);
      console.error(`[admin] import failed (${req.fileName}): ${errorText(e)}`);
      patch(j.id, { stage: 'failed', error: errorText(e), finishedAt: new Date().toISOString() });
    }
  };

  /** 全アカウントの履歴から、同名・同サイズの ZIP の最新の取り込み記録 */
  const latestImportAcrossAccounts = (name: string, size: number): ImportRecord | null =>
    registry
      .handles()
      .flatMap((h) => {
        const r = h.queries.latestImportOf(name, size);
        return r === null ? [] : [r];
      })
      .reduce<ImportRecord | null>((best, r) => (best === null || Date.parse(r.finishedAt) > Date.parse(best.finishedAt) ? r : best), null);

  const archives = async (): Promise<ArchiveFile[]> => {
    let names: string[];
    try {
      names = (await readdir(archiveDir)).filter((n) => isPlainZipName(n));
    } catch (e) {
      if (e instanceof Error && 'code' in e && e.code === 'ENOENT') return [];
      throw new Error(`ARCHIVE_DIR を読めません (${archiveDir}): ${errorText(e)}`, { cause: e });
    }
    const stats = await Promise.all(names.map(async (name) => ({ name, st: await stat(join(archiveDir, name)) })));
    return stats
      .filter(({ st }) => st.isFile())
      .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)
      .map(({ name, st }) => ({
        name,
        size: st.size,
        modifiedAt: st.mtime.toISOString(),
        imported: latestImportAcrossAccounts(name, st.size),
      }));
  };

  const startImport = (body: unknown): ImportJob => {
    const req = parseImportRequest(body);
    if (isRunning(job)) throw new HttpError(409, 'an import is already running');
    const zipPath = join(archiveDir, req.fileName);
    if (!existsSync(zipPath)) throw new HttpError(400, `archive not found: ${req.fileName}`);
    const j = newJob(req.fileName);
    job = j;
    void run(j, req);
    return j;
  };

  const reset = (body: unknown): void => {
    const { accountId } = parseResetRequest(body);
    if (isRunning(job)) throw new HttpError(409, 'an import is running');
    if (!registry.has(accountId)) throw new HttpError(404, 'account not found');
    registry.remove(accountId);
    console.log(`[admin] database reset: account ${accountId}`);
  };

  return {
    archives,
    status: () => job,
    startImport,
    reset,
    abort: () => {
      child?.kill('SIGTERM');
      const known = job?.account ?? null;
      if (known !== null && isAccountId(known.id)) removeDbFiles(tmpPathFor(accountDbPath(dbDir, known.id)));
    },
  };
};
