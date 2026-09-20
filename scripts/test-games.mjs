#!/usr/bin/env node
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const outdir = await mkdtemp(path.join(tmpdir(), "htn-games-"));
const outfile = path.join(outdir, "game.test.mjs");

try {
  await build({
    entryPoints: ["tests/game.test.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outfile,
  });
  const result = spawnSync(process.execPath, ["--test", outfile], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally {
  await rm(outdir, { recursive: true, force: true });
}
