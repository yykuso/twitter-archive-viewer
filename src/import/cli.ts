import { existsSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { performance } from 'node:perf_hooks';
import { migrateLegacyLayout } from '../db/legacy.ts';
import { closeAsSingleFile, config, openDb } from '../db/open.ts';
import { accountDbPath, accountMediaDir, assertAccountId } from '../db/paths.ts';
import { swapDatabase, tmpPathFor } from '../db/swap.ts';
import type { ImportStats } from '../shared/types.ts';
import { buildMergedDb } from './build.ts';
import { MEDIA_DIRS, countMediaEntries, mediaPatterns } from './media.ts';
import { countRows, setImportMediaFiles } from './merge.ts';
import type { ImportData } from './merge.ts';
import { loadDms, loadLikes, loadProfile, loadTweets, parseJsAssignment, parseManifest } from './parse.ts';
import {
  buildMediaIndex,
  decodeHtmlEntities,
  resolveAvatar,
  transformAllTweets,
  transformDms,
  transformLikes,
} from './transform.ts';
import { extractMedia, listEntries, readEntryText } from './zip.ts';

type Args = {
  readonly zip: string;
  readonly skipMedia: boolean;
  /** true なら DB を tmp に作るだけで止める (差し替えとメディア展開は呼び出し元 = サーバーが行う) */
  readonly buildOnly: boolean;
  readonly progressJson: boolean;
};

const USAGE = '使い方: cli.ts <archive.zip> [--skip-media] [--build-only] [--progress-json]';

const parseArgs = (argv: readonly string[]): Args => {
  const positional: string[] = [];
  let skipMedia = false;
  let progressJson = false;
  let buildOnly = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] ?? '';
    if (a === '--skip-media') skipMedia = true;
    else if (a === '--progress-json') progressJson = true;
    else if (a === '--build-only') buildOnly = true;
    else if (a.startsWith('--')) throw new Error(`不明なオプション: ${a}\n${USAGE}`);
    else positional.push(a);
  }
  const [zip, ...rest] = positional;
  if (zip === undefined || rest.length > 0) throw new Error(USAGE);
  if (!existsSync(zip) || !statSync(zip).isFile()) throw new Error(`ZIP ファイルが見つかりません: ${zip}`);
  return { zip, skipMedia, buildOnly, progressJson };
};

const secs = (since: number): string => `${((performance.now() - since) / 1000).toFixed(1)}s`;

/** manifest の generationDate (ISO) を Unix ms にする。無い・不正ならエラー */
const generationMs = (iso: string | null): number => {
  if (iso === null) throw new Error('manifest の archiveInfo.generationDate がありません (アーカイブの世代を判定できません)');
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`manifest の archiveInfo.generationDate が不正です: ${iso}`);
  return ms;
};

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  const { zip, skipMedia, progressJson } = args;
  // --progress-json では stdout を JSON 行専用にし、人間向けログは stderr へ
  const log = (msg: string): void => {
    if (progressJson) process.stderr.write(`${msg}\n`);
    else console.log(msg);
  };
  const emit = (event: Record<string, unknown>): void => {
    if (progressJson) process.stdout.write(`${JSON.stringify(event)}\n`);
  };
  const t0 = performance.now();
  const startedAt = Date.now();
  const standalone = !args.buildOnly;

  if (standalone) {
    // サーバー経由なら起動時に移行済み。スタンドアロンでは旧レイアウトが残っていればここで移行する (冪等)
    migrateLegacyLayout({ legacyDbPath: config.legacyDbPath, dbDir: config.dbDir, mediaRoot: config.mediaRoot });
    log('警告: スタンドアロン取り込みです。サーバーが起動中、または別の取り込みを実行中でないことを確認してください');
  }

  log(`ZIP: ${zip}`);
  emit({ stage: 'reading', message: 'ZIP を読み込み中' });
  const entries = await listEntries(zip);
  log(`エントリ数: ${entries.length}`);
  const index = buildMediaIndex(entries, MEDIA_DIRS);

  const manifest = parseManifest(parseJsAssignment(await readEntryText(zip, 'data/manifest.js'), 'data/manifest.js'));
  const accountId = assertAccountId(manifest.accountId);
  const dbPath = accountDbPath(config.dbDir, accountId);
  const tmpPath = tmpPathFor(dbPath);
  const mediaDir = accountMediaDir(config.mediaRoot, accountId);
  log(`アカウント: @${manifest.userName} (${accountId}) → ${dbPath}`);
  emit({ stage: 'reading', account: { id: accountId, username: manifest.userName } });
  const generatedAt = generationMs(manifest.generationDate);
  log(`アーカイブ生成日時: ${new Date(generatedAt).toISOString()}`);
  const [rawTweets, rawDeleted, rawLikes, rawDms, rawGroupDms, profile] = await Promise.all([
    loadTweets(zip, manifest.files('tweets')),
    loadTweets(zip, manifest.files('deletedTweets')),
    loadLikes(zip, manifest.files('like')),
    loadDms(zip, manifest.files('directMessages'), false),
    loadDms(zip, manifest.files('directMessagesGroup'), true),
    loadProfile(zip, manifest.files('profile')),
  ]);
  log(`読み込み完了 (${secs(t0)})`);

  const tweets = transformAllTweets(rawTweets, rawDeleted, index);
  const likes = transformLikes(rawLikes);
  const dms = transformDms([...rawDms, ...rawGroupDms], index);
  const avatar = resolveAvatar(manifest.accountId, profile.avatarMediaUrl, index);

  const data: ImportData = {
    tweets,
    likes,
    dmConversations: dms.conversations,
    dmMessages: dms.messages,
    meta: {
      account_id: manifest.accountId,
      username: manifest.userName,
      display_name: manifest.displayName,
      bio: profile.bio === null ? null : decodeHtmlEntities(profile.bio),
      avatar_file: avatar,
    },
  };

  emit({ stage: 'writing', message: 'DB にマージ中' });
  const tWrite = performance.now();
  const { importId, stats } = buildMergedDb(dbPath, tmpPath, {
    data,
    generatedAt,
    fileName: basename(zip),
    fileSize: statSync(zip).size,
    startedAt,
    now: Date.now(),
  });
  log(`マージ DB 作成完了 (${secs(tWrite)}): ${tmpPath}`);
  const printStats = (s: ImportStats): void => {
    for (const [name, t] of [['tweets', s.tweets], ['likes', s.likes], ['dmMessages', s.dmMessages]] as const) {
      log(`  ${name}: 追加 ${t.added} / 更新 ${t.updated} / 今回含まれていた ${t.seen}`);
    }
    log(`  消失扱い: tweets ${s.removed.tweets} / likes ${s.removed.likes} / dmMessages ${s.removed.dmMessages}`);
  };
  printStats(stats);

  const mediaRows = tweets.flatMap((t) => t.media);
  log(`ツイートメディア: ${mediaRows.length} 件中 ${mediaRows.filter((m) => m.file !== null).length} 件のファイルを解決`);
  log(`DM メディア: ${dms.messages.reduce((n, m) => n + m.media.length, 0)} 件解決`);
  log(`アバター: ${avatar ?? 'なし'}`);
  if (dms.emptyConversations > 0) log(`メッセージ 0 件のため除外した DM 会話: ${dms.emptyConversations}`);

  if (!standalone) {
    // サーバー用: 差し替えとメディア展開は呼び出し側が行う
    emit({ stage: 'built', accountId, generatedAt, importId, stats });
    return;
  }

  swapDatabase(dbPath, tmpPath);
  log(`DB を差し替えました: ${dbPath}`);

  let mediaFiles = 0;
  if (skipMedia) {
    log('--skip-media: メディア展開をスキップ');
  } else {
    const patterns = mediaPatterns(entries);
    const tMedia = performance.now();
    log(`メディア展開開始 → ${mediaDir} (${patterns.length} ディレクトリ, ${countMediaEntries(entries)} ファイル)`);
    mediaFiles = await extractMedia(zip, patterns, mediaDir);
    log(`メディア展開完了 (${secs(tMedia)}): 新規 ${mediaFiles} ファイル`);
    const db = openDb(dbPath);
    try {
      setImportMediaFiles(db, importId, mediaFiles);
    } finally {
      closeAsSingleFile(db);
    }
  }
  const db = openDb(dbPath, { readOnly: true });
  try {
    for (const [table, n] of Object.entries(countRows(db))) log(`  ${table}: ${n}`);
  } finally {
    db.close();
  }
  log(`全体: ${secs(t0)}`);
};

main().catch((e: unknown) => {
  console.error(`エラー: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
