import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { migrateLegacyLayout } from '../db/legacy.ts';
import { config } from '../db/open.ts';
import { settingsPathOf } from '../db/paths.ts';
import { createAdmin } from './admin.ts';
import { applyCommonHeaders } from './http.ts';
import { createRegistry, prepareAccountDbs } from './registry.ts';
import { createHandler } from './router.ts';
import { createSettings } from './settings.ts';
import { assertValidTimeZone, selfCheckTimeZone } from './timezone.ts';

const webRoot = process.env['WEB_ROOT'] ?? fileURLToPath(new URL('../../web/dist', import.meta.url));

if (config.envTimeZone !== null) assertValidTimeZone(config.envTimeZone);
selfCheckTimeZone();

// 旧レイアウト (単一 DB) の移行 → 取り込み途中の .tmp の掃除・旧スキーマの退避 → 設定の読み込み
migrateLegacyLayout({ legacyDbPath: config.legacyDbPath, dbDir: config.dbDir, mediaRoot: config.mediaRoot });
prepareAccountDbs(config.dbDir);
const settings = createSettings({ path: settingsPathOf(config.dbDir), envTimeZone: config.envTimeZone });
const registry = createRegistry({ dbDir: config.dbDir, getTimeZone: settings.timeZone });
const admin = createAdmin({ registry, dbDir: config.dbDir, archiveDir: config.archiveDir, mediaRoot: config.mediaRoot });
const handler = createHandler({ registry, settings, admin, mediaRoot: config.mediaRoot, webRoot });

const server = createServer((req, res) => {
  const started = performance.now();
  applyCommonHeaders(res);
  res.on('close', () => {
    const ms = Math.round(performance.now() - started);
    console.log(`${req.method} ${req.url} ${res.statusCode} ${ms}ms`);
  });
  void handler(req, res);
});

const shutdown = (signal: string): void => {
  console.log(`[main] ${signal} received, shutting down`);
  admin.abort();
  server.close((err) => {
    try {
      registry.closeAll();
    } catch (e) {
      console.error(`[main] db close failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    process.exit(err === undefined ? 0 : 1);
  });
  server.closeIdleConnections();
  setTimeout(() => {
    console.error('[main] forced exit after timeout');
    process.exit(1);
  }, 5000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(config.port, '0.0.0.0', () => {
  console.log(
    `[main] listening on :${config.port} db=${config.dbDir} archive=${config.archiveDir} media=${config.mediaRoot} tz=${settings.timeZone()} (${settings.get().timezoneSource}) accounts=${registry.list().length} web=${webRoot}`,
  );
});
