import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

import { cloudflare } from "@cloudflare/vite-plugin";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), cloudflare()],
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: {
    include: ['react', 'react-dom', 'better-auth/react', '@better-auth/passkey/client'],
    exclude: ['better-auth', '@better-auth/kysely-adapter', 'better-auth/db/migration'],
  },
})
