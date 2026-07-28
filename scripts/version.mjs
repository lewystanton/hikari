/* One version across both apps.
   Desktop and Android had drifted to 2.25.1 and 0.23.1 — two numbers for one
   product, so "which build has the franchise fix?" needed a lookup table.
   They share a version now, and this is the only thing that sets it.

   Android additionally needs a monotonically increasing integer versionCode;
   Play Store will not accept a decrease, so it only ever counts up.

     node scripts/version.mjs            show the current version
     node scripts/version.mjs 3.0.0      set an explicit version
     node scripts/version.mjs patch      3.0.0 -> 3.0.1
     node scripts/version.mjs minor      3.0.1 -> 3.1.0
     node scripts/version.mjs major      3.1.0 -> 4.0.0
*/
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP = path.join(ROOT, 'package.json');
const MOBILE = path.join(ROOT, 'mobile', 'package.json');
const GRADLE = path.join(ROOT, 'mobile', 'android', 'app', 'build.gradle');

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJson = (p, o) => writeFileSync(p, JSON.stringify(o, null, 2) + '\n');

const desktop = readJson(DESKTOP);
const arg = process.argv[2];

if (!arg) {
  const mobile = readJson(MOBILE);
  const gradle = readFileSync(GRADLE, 'utf8');
  console.log(`desktop      ${desktop.version}`);
  console.log(`mobile       ${mobile.version}`);
  console.log(`versionName  ${/versionName "([^"]+)"/.exec(gradle)?.[1]}`);
  console.log(`versionCode  ${/versionCode (\d+)/.exec(gradle)?.[1]}`);
  console.log(desktop.version === mobile.version ? '\nin sync' : '\nOUT OF SYNC — run: node scripts/version.mjs <version|patch|minor|major>');
  process.exit(0);
}

/* the desktop number is the one with real history, so bumps start from it */
let next = arg;
if (['major', 'minor', 'patch'].includes(arg)) {
  const [maj, min, pat] = desktop.version.split('.').map(Number);
  next = arg === 'major' ? `${maj + 1}.0.0`
    : arg === 'minor' ? `${maj}.${min + 1}.0`
    : `${maj}.${min}.${pat + 1}`;
}
if (!/^\d+\.\d+\.\d+$/.test(next)) {
  console.error(`"${next}" is not a semver version`);
  process.exit(1);
}

desktop.version = next;
writeJson(DESKTOP, desktop);

const mobile = readJson(MOBILE);
mobile.version = next;
writeJson(MOBILE, mobile);

let gradle = readFileSync(GRADLE, 'utf8');
const currentCode = Number(/versionCode (\d+)/.exec(gradle)?.[1] ?? 0);
gradle = gradle
  .replace(/versionCode \d+/, `versionCode ${currentCode + 1}`)
  .replace(/versionName "[^"]+"/, `versionName "${next}"`);
writeFileSync(GRADLE, gradle);

console.log(`version   ${next}  (desktop + mobile)`);
console.log(`versionCode ${currentCode + 1}`);
