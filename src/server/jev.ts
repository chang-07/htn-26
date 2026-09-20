import { traceOperation } from "./telemetry.ts";
import { z } from "zod";

export type JevEnv = {
  AI_GATEWAY_API_KEY?: string;
  JEV_MODEL?: string;
};

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const endpoint = "https://ai-gateway.vercel.sh/typesafe/v1/systemone";

export const hasJev = (env: JevEnv) => !!env.AI_GATEWAY_API_KEY?.trim();

export function requireJev(env: JevEnv) {
  if (!hasJev(env)) throw new Error("AI_GATEWAY_API_KEY is required for Jev scoring");
  if (env.JEV_MODEL && env.JEV_MODEL !== "typesafe-ai/jev") throw new Error("Jev requires typesafe-ai/jev");
}

/**
 * Submit one bounded System One decision. Callers own their response schema
 * and act only on its parsed result; this transport never logs upstream bodies.
 */
export async function askJev<T>(
  env: JevEnv,
  state: unknown,
  questions: Record<string, unknown>,
  schema: z.ZodType<T>,
  fetchImpl: FetchImpl = fetch,
): Promise<T> {
  requireJev(env);
  const response = await traceOperation("provider.systemone", "http.client", { provider: new URL(endpoint).hostname }, () => fetchImpl(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.AI_GATEWAY_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "typesafe-ai/jev", state, questions }),
    signal: AbortSignal.timeout(30_000),
  }));
  // An upstream error can reflect the request, including authorization data.
  if (!response.ok) throw new Error(`${new URL(endpoint).hostname}${new URL(endpoint).pathname}: HTTP ${response.status}`);
  return schema.parse(await response.json());
}
