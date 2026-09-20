import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

// tools/index.ts imports siblings without extensions, so it is bundled the way research.ts is in its test.
const bundle = await build({ entryPoints: ["src/server/tools/index.ts"], bundle: true, write: false, format: "esm", platform: "node" });
const { openAiTools, toolSchemas } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

test("the tool list sent to the model is built once, not on every model call", () => {
  const first = openAiTools();
  assert.equal(openAiTools(), first);
  assert.equal(first.length, Object.keys(toolSchemas).length);
  assert.ok(first.every((t) => t.type === "function" && t.function.parameters.type === "object"));
});
