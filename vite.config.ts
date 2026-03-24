import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(() => ({
  base: process.env.GITHUB_ACTIONS ? '/dandan/' : '/',
  plugins: [react()],
  esbuild: {
    loader: 'tsx',
    include: /dandan\.ts$/
  }
}));
