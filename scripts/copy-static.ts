// web/index.html などの静的ファイルを web/dist/ にコピーする (Node 組み込みのみ)
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'web', 'dist');
const files = ['index.html', 'style.css', 'icon.svg'];

mkdirSync(outDir, { recursive: true });
for (const f of files) {
  copyFileSync(join(root, 'web', f), join(outDir, f));
  console.log(`copied web/${f} -> web/dist/${f}`);
}
