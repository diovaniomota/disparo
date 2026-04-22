import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envDir = path.resolve(__dirname, "..");

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, envDir, "");
  const port = Number(process.env.VITE_PORT || env.VITE_PORT || 5173);
  const backendPort = Number(process.env.PORT || env.PORT || 3001);
  const apiTarget = String(
    process.env.VITE_API_BASE_URL || env.VITE_API_BASE_URL || `http://localhost:${backendPort}`,
  ).replace(/\/$/, "");

  return {
    plugins: [react()],
    envDir,
    server: {
      port,
      strictPort: true,
      proxy: {
        "/api": {
          target: apiTarget,
          changeOrigin: true,
        },
        "/socket.io": {
          target: apiTarget,
          changeOrigin: true,
          ws: true,
        },
      },
    },
  };
});
