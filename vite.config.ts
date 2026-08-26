import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'

// localhost counts as a secure context, so plain HTTP is fine for desktop work.
// Reaching the dev server from a phone means hitting http://<lan-ip>, which is
// NOT a secure context and gets the microphone blocked — so `npm run dev:phone`
// turns on HTTPS with a self-signed cert (accept the browser warning once).
export default defineConfig(({ mode }) => {
  const phone = mode === 'phone'
  return {
    plugins: [react(), ...(phone ? [basicSsl()] : [])],
    server: { host: phone },
  }
})
