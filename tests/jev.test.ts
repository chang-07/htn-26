import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { askJev } from "../src/server/jev";

const Questions = {
  surface: {
    type: "choice",
    instructions: "Choose the only supported surface for this prompt.",
    criteria: {
      choice_rounds: "A turn-based game made of written choices.",
      tap_dodge: "A solo one-thumb game avoiding obstacles.",
      needs_choice: "The prompt does not clearly fit either supported surface.",
    },
  },
};

const ResponseZ = z.object({
  answers: z.object({
    surface: z.object({
      type: z.literal("choice"),
      choice: z.enum(["choice_rounds", "tap_dodge", "needs_choice"]),
      confidence: z.number().min(0).max(1),
      probabilities: z.record(z.string(), z.number().min(0).max(1)),
    }),
  }),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
});

test("askJev sends a typed System One request and returns the parsed result", async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const result = await askJev(
    { AI_GATEWAY_API_KEY: "gateway-test-key" },
    { prompt: "Make pigeons dodge office chairs" },
    Questions,
    ResponseZ,
    async (url, init) => {
      request = { url: String(url), init };
      return new Response(JSON.stringify({
        answers: { surface: { type: "choice", choice: "tap_dodge", confidence: 0.91, probabilities: { choice_rounds: 0.04, tap_dodge: 0.95, needs_choice: 0.01 } } },
        usage: { input_tokens: 12, output_tokens: 3 },
      }));
    },
  );

  assert.equal(request?.url, "https://ai-gateway.vercel.sh/typesafe/v1/systemone");
  assert.equal(request?.init?.method, "POST");
  assert.equal(new Headers(request?.init?.headers).get("content-type"), "application/json");
  assert.equal(new Headers(request?.init?.headers).get("authorization"), "Bearer gateway-test-key");
  assert.deepEqual(JSON.parse(String(request?.init?.body)), {
    model: "typesafe-ai/jev",
    state: { prompt: "Make pigeons dodge office chairs" },
    questions: Questions,
  });
  assert.equal(result.answers.surface.choice, "tap_dodge");
});

test("askJev rejects a missing gateway key before making a request", async () => {
  await assert.rejects(
    () => askJev({}, { prompt: "hello" }, Questions, ResponseZ),
    /AI_GATEWAY_API_KEY is required/,
  );
});

test("askJev does not echo an upstream response body in its error", async () => {
  await assert.rejects(
    () => askJev(
      { AI_GATEWAY_API_KEY: "gateway-test-key" },
      { prompt: "hello" },
      Questions,
      ResponseZ,
      async () => new Response("upstream echoed gateway-test-key", { status: 401 }),
    ),
    (error: unknown) => {
      assert.match(String(error), /HTTP 401/);
      assert.doesNotMatch(String(error), /gateway-test-key/);
      return true;
    },
  );
});
