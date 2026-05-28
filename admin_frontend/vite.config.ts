// FILE: ~/otmega/otmega_app/console/admin_frontend/vite.config.ts
// ماموریت: تنظیم Vite برای build فرانت وبی Admin Console.

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
