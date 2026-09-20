#!/usr/bin/env node
import { build } from "esbuild";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const outdir = await mkdtemp(path.join(tmpdir(), "htn-games-"));

try {
  const entryPoints = (await readdir("tests"))
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => path.join("tests", name));
  await build({
    entryPoints,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outdir,
  });
  const files = entryPoints.map((entry) => path.join(outdir, path.basename(entry, ".ts") + ".js"));
  const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally {
  await rm(outdir, { recursive: true, force: true });
}
