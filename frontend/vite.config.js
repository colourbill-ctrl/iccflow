import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Port 5175 — icctools=5173, icceval=5174, iccflow=5175. All three apps can
// run side-by-side in dev and be served from distinct ports on chardata.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5175,
    strictPort: true,
  },
  preview: {
    port: 5175,
    strictPort: true,
  },
})
