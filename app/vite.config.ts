import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import {defineConfig} from 'vite';

const build = Date.now().toString(36);

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'stamp',
      transformIndexHtml: html => html.replaceAll('__BUILD__', build),
    },
  ],
  define: {__BUILD__: JSON.stringify(build)},
});
