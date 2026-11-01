import { execFileSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { themeInitScript } from '@cqu-moe/theme';

const themeInitFile = 'theme-init.js';

export default defineConfig({
  define: { "import.meta.env.VITE_RELEASE": JSON.stringify(process.env.CF_BUILD_COMMIT_SHA || process.env.VITE_RELEASE || execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()) },
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'theme-init',
      configureServer(server) {
        server.middlewares.use(`/${themeInitFile}`, (_request, response) => {
          response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
          response.setHeader('Cache-Control', 'no-cache');
          response.end(themeInitScript);
        });
      },
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: themeInitFile, source: themeInitScript });
      },
      transformIndexHtml: () => [
        // The package builds this string from Function#toString. Worker bundling
        // changes those bytes, so an inline CSP hash cannot be shared reliably.
        { tag: 'script', attrs: { src: `/${themeInitFile}` }, injectTo: 'head-prepend' },
      ],
    },
  ],
  server: { host: '127.0.0.1', port: 5174, strictPort: true },
});
