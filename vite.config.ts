import { execFileSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { themeInitScript } from '@cqu-moe/theme';
export default defineConfig({
  define: { "import.meta.env.VITE_RELEASE": JSON.stringify(process.env.CF_BUILD_COMMIT_SHA || process.env.VITE_RELEASE || execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()) },
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'theme-init',
      transformIndexHtml: () => [
        { tag: 'script', children: themeInitScript, injectTo: 'head-prepend' },
      ],
    },
  ],
  server: { host: '127.0.0.1', port: 5174, strictPort: true },
});
