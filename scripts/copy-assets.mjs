// Copies the built web SPA into the server dist so `node server/dist/index.js`
// can serve it in production. Safe to run even if web/dist does not exist yet.
import { cp, mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'web/dist');
const dest = resolve(root, 'server/dist/public');

try {
  await stat(src);
} catch {
  console.warn('[copy-assets] web/dist not found, skipping SPA copy');
  process.exit(0);
}

await mkdir(dirname(dest), { recursive: true });
await cp(src, dest, { recursive: true });
console.log(`[copy-assets] copied ${src} -> ${dest}`);
