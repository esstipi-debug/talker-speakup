import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Proxy API calls to the Express server so the client stays same-origin (no CORS dance).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/turn": "http://localhost:3001",
      "/health": "http://localhost:3001",
      "/progress": "http://localhost:3001",
      "/pron": "http://localhost:3001",
    },
  },
});
