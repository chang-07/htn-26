import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import agents from "agents/vite";

/**
 * Page captures live with the deployment that took them. When looking at runs
 * copied down from production, SHOT_ORIGIN=https://… borrows its images. A
 * middleware rather than `server.proxy`, which the Worker would answer first.
 */
const borrowShots = (origin: string | undefined): Plugin => ({
  name: "borrow-shots",
  configureServer(server) {
    if (!origin) return;
    server.middlewares.use("/shot", async (req, res) => {
      const upstream = await fetch(`${origin}/shot${req.url ?? ""}`).catch(() => null);
      res.statusCode = upstream?.status ?? 502;
      res.setHeader("content-type", upstream?.headers.get("content-type") ?? "text/plain");
      res.end(upstream ? Buffer.from(await upstream.arrayBuffer()) : "unreachable");
    });
  },
});

export default defineConfig({
  // `agents()` transforms TC39 decorators; without it `@callable()` is a syntax
  // error at Worker startup.
  plugins: [borrowShots(process.env.SHOT_ORIGIN), agents(), react(), cloudflare()],
  // Let a cloudflared quick tunnel reach the dev server.
  // Bound to 127.0.0.1 because cloudflared dials IPv4 and Vite defaults to [::1].
  server: {
    host: "127.0.0.1",
    allowedHosts: [".trycloudflare.com"],
  },
});
