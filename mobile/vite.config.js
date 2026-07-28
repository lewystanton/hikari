import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

/* Dev server doubles as the desktop-preview target (ionic-serve style).
   Capacitor later wraps `dist/` unchanged — keep everything relative. */
export default defineConfig({
  base: './',
  /* so Diagnostics can name the build a bug report came from */
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: { port: 5175, strictPort: true, host: '127.0.0.1' },
  build: { target: 'es2020' }
});
