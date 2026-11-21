import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream';

const MIME: Readonly<Record<string, string>> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

export const contentTypeFor = (path: string): string =>
  MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';

export type RangeResult =
  | { readonly kind: 'none' }
  | { readonly kind: 'range'; readonly start: number; readonly end: number }
  | { readonly kind: 'unsatisfiable' };

/** 単一 Range のみ対応。構文不正・複数範囲は無視 (全体を返す) */
export const parseRange = (header: string | undefined, size: number): RangeResult => {
  if (header === undefined) return { kind: 'none' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (m === null) return { kind: 'none' };
  const [a, b] = [m[1] ?? '', m[2] ?? ''];
  if (a === '' && b === '') return { kind: 'none' };
  if (a === '') {
    const suffix = Number(b);
    if (suffix === 0 || size === 0) return { kind: 'unsatisfiable' };
    return { kind: 'range', start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(a);
  if (start >= size) return { kind: 'unsatisfiable' };
  const end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  if (end < start) return { kind: 'none' };
  return { kind: 'range', start, end };
};

/** root 配下の相対パスを字句的に解決する。不正 (トラバーサル等) なら null */
export const resolveUnder = (root: string, rel: string): string | null => {
  if (rel.includes('\0') || rel.includes('\\') || rel.startsWith('/')) return null;
  if (rel.split('/').some((seg) => seg === '..')) return null;
  const rootAbs = resolve(root);
  const full = resolve(rootAbs, rel);
  return full === rootAbs || full.startsWith(rootAbs + sep) ? full : null;
};

const isMissing = (e: unknown): boolean =>
  e instanceof Error && 'code' in e && (e.code === 'ENOENT' || e.code === 'ENOTDIR');

export type Located = { readonly path: string; readonly stats: Stats };

/** シンボリックリンクで root 外へ出ないことも確認し、通常ファイルなら返す */
export const locateFile = async (root: string, candidate: string): Promise<Located | null> => {
  try {
    const [realRoot, real] = await Promise.all([realpath(root), realpath(candidate)]);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) return null;
    const stats = await stat(real);
    return stats.isFile() ? { path: real, stats } : null;
  } catch (e) {
    if (isMissing(e)) return null;
    throw e;
  }
};

export const sendFile = (
  req: IncomingMessage,
  res: ServerResponse,
  file: Located,
  cacheControl: string,
): void => {
  const size = file.stats.size;
  const range = parseRange(req.headers.range, size);
  res.setHeader('Content-Type', contentTypeFor(file.path));
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', cacheControl);
  res.setHeader('Last-Modified', file.stats.mtime.toUTCString());

  if (range.kind === 'unsatisfiable') {
    res.setHeader('Content-Range', `bytes */${size}`);
    res.writeHead(416, { 'Content-Length': 0 });
    res.end();
    return;
  }
  const [start, end] = range.kind === 'range' ? [range.start, range.end] : [0, size - 1];
  const length = size === 0 ? 0 : end - start + 1;
  if (range.kind === 'range') res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  res.writeHead(range.kind === 'range' ? 206 : 200, { 'Content-Length': length });
  if (req.method === 'HEAD' || length === 0) {
    res.end();
    return;
  }
  pipeline(createReadStream(file.path, { start, end }), res, (err) => {
    if (err === undefined || err === null) return;
    // クライアント切断は通常動作
    if ('code' in err && err.code === 'ERR_STREAM_PREMATURE_CLOSE') return;
    console.error(`[files] stream error for ${file.path}: ${err.message}`);
    if (!res.writableEnded) res.destroy();
  });
};
