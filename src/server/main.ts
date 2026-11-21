import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { config } from '../db/open.ts';
import { createAdmin } from './admin.ts';
import { createDbHolder, prepareDbFile } from './db-holder.ts';
import { applyCommonHeaders } from './http.ts';
import { createQueries } from './queries.ts';
import { createHandler } from './router.ts';
import { assertValidTimeZone, selfCheckTimeZone } from './timezone.ts';

const webRoot = process.env['WEB_ROOT'] ?? fileURLToPath(new URL('../../web/dist', import.meta.url));

assertValidTimeZone(config.timeZone);
selfCheckTimeZone();

// 取り込み途中の .tmp を片付け、DB が無ければ空のスキーマだけの DB を作ってから読み取り専用で開く
prepareDbFile(config.dbPath);
const holder = createDbHolder(config.dbPath);
holder.reopen();
const queries = createQueries(holder, config.timeZone);
const admin = createAdmin({ holder, queries, archiveDir: config.archiveDir, mediaRoot: config.mediaRoot });
const handler = createHandler({ queries, admin, mediaRoot: config.mediaRoot, timeZone: config.timeZone, webRoot });

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
      holder.close();
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
  console.log(`[main] listening on :${config.port} db=${config.dbPath} archive=${config.archiveDir} media=${config.mediaRoot} tz=${config.timeZone} web=${webRoot}`);
});
