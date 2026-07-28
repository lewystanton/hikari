/* Delete previously built installers before a new build.
   `dist/` had accumulated 2.4 GB of superseded 190 MB installers, which is
   the sort of thing nobody notices until a disk fills up. Runs from `predist`
   so it happens whether or not anyone remembers.

   Deliberately narrow: only files this project builds, matched by name, and
   only in `dist/`. Everything else there (win-unpacked, the APKs) is left
   alone unless --all is passed. */
import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const ALSO_APKS = process.argv.includes('--all');

/* Anything matching these is a build output we can regenerate at will. */
const PATTERNS = [
  /^Hikari-Setup-\d+\.\d+\.\d+\.exe$/,
  /^Hikari-Setup-\d+\.\d+\.\d+\.exe\.blockmap$/,
  /^Hikari-Setup-\d+\.\d+\.\d+\.__uninstaller\.exe$/,
  /^Hikari-\d+\.\d+\.\d+(-arm64)?\.dmg$/,          // macOS build
  /^Hikari-\d+\.\d+\.\d+(-arm64)?\.dmg\.blockmap$/,
  ...(ALSO_APKS ? [/^Hikari-Mobile-\d+\.\d+\.\d+\.apk$/] : [])
];

const mb = (n) => (n / 1024 / 1024).toFixed(1);

let files;
try {
  files = await readdir(DIST);
} catch {
  console.log('[clean-dist] no dist/ yet — nothing to do');
  process.exit(0);
}

let freed = 0, removed = 0;
for (const name of files) {
  if (!PATTERNS.some((re) => re.test(name))) continue;
  const full = path.join(DIST, name);
  try {
    const s = await stat(full);
    await rm(full, { force: true });
    freed += s.size;
    removed++;
  } catch (e) {
    console.warn(`[clean-dist] could not remove ${name}: ${e.message}`);
  }
}

console.log(removed
  ? `[clean-dist] removed ${removed} old artefact${removed === 1 ? '' : 's'}, freed ${mb(freed)} MB`
  : '[clean-dist] nothing to remove');
