import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import agents from "agents/vite";

export default defineConfig({
  // `agents()` transforms TC39 decorators; without it `@callable()` is a syntax
  // error at Worker startup.
  plugins: [agents(), react(), cloudflare()],
  // Let a cloudflared quick tunnel reach the dev server.
  // Bound to 127.0.0.1 because cloudflared dials IPv4 and Vite defaults to [::1].
  server: { host: "127.0.0.1", allowedHosts: [".trycloudflare.com"] },
});
