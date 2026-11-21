import { spawn } from 'node:child_process';

type RunResult = { readonly code: number; readonly stdout: Buffer; readonly stderr: string };

/** 行単位のコールバック。末尾の改行・CR は除去済み */
export type LineHandler = (line: string) => void;

/**
 * unzip を引数配列で起動する (シェルは経由しない)。
 * onStdoutLine を渡すと stdout を行ごとに通知し、全体は溜め込まない (大量出力向け)。
 */
const runUnzip = (args: readonly string[], onStdoutLine?: LineHandler): Promise<RunResult> =>
  new Promise((resolve, reject) => {
    const child = spawn('unzip', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let pending = '';
    child.stdout.on('data', (chunk: Buffer) => {
      if (onStdoutLine === undefined) {
        out.push(chunk);
        return;
      }
      pending += chunk.toString('utf8');
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const l of lines) onStdoutLine(l.replace(/\r$/, ''));
    });
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', (e) => reject(new Error(`unzip を起動できませんでした: ${e.message}`)));
    child.on('close', (code) => {
      if (onStdoutLine !== undefined && pending !== '') onStdoutLine(pending.replace(/\r$/, ''));
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
  });

/** ZIP 内の全エントリ名 */
export const listEntries = async (zip: string): Promise<readonly string[]> => {
  const r = await runUnzip(['-Z1', zip]);
  if (r.code !== 0) throw new Error(`unzip -Z1 が失敗しました (code ${r.code}): ${zip}\n${r.stderr}`);
  return r.stdout
    .toString('utf8')
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l !== '');
};

/** ZIP 内のテキストファイルを読む */
export const readEntryText = async (zip: string, entry: string): Promise<string> => {
  const r = await runUnzip(['-p', zip, entry]);
  if (r.code !== 0) {
    throw new Error(`ZIP から ${entry} を読めませんでした (code ${r.code}): ${r.stderr}`);
  }
  return r.stdout.toString('utf8');
};

/** unzip の stdout の 1 行が「ファイルを 1 つ書き出した」ことを表すか (inflating / extracting) */
export const isExtractedLine = (line: string): boolean => /^\s*(inflating|extracting):\s/.test(line);

/**
 * 既存ファイルを上書きせずに、パターンに一致するエントリを destDir へ展開する。
 * onLine には unzip の stdout を 1 行ずつ渡す。戻り値は書き出したファイル数。
 * 終了コード 1 (警告: 既存ファイルのスキップ等) と 11 (一致なし) は成功扱い。
 */
export const extractMedia = async (
  zip: string,
  patterns: readonly string[],
  destDir: string,
  onLine?: LineHandler,
): Promise<number> => {
  if (patterns.length === 0) return 0;
  let extracted = 0;
  const r = await runUnzip(['-n', zip, ...patterns, '-d', destDir], (line) => {
    if (isExtractedLine(line)) extracted += 1;
    onLine?.(line);
  });
  if (r.code !== 0 && r.code !== 1 && r.code !== 11) {
    throw new Error(`メディアの展開に失敗しました (code ${r.code}): ${r.stderr}`);
  }
  if (r.code !== 0 && r.stderr.trim() !== '') {
    process.stderr.write(`unzip warning (code ${r.code}): ${r.stderr.trim()}\n`);
  }
  return extracted;
};
