import OpenAI from "openai";
import { z } from "zod";
import { log } from "./log";

/**
 * Two usage sources behind one interface, switched by LLM_PROFILE:
 *
 *  - "demo": OpenAI, spending the team's credits. Use for the demo and for
 *    final prompt tuning.
 *  - "dev":  any OpenAI-compatible endpoint (Workers AI, Ollama, ...), so that
 *    day-to-day testing costs nothing against those credits.
 *
 * Both speak the Chat Completions tool-calling protocol, so the agent loop does
 * not know or care which one it is talking to.
 */
export function llmFor(env: Env): { client: OpenAI; model: string; profile: string } {
  const wantsDev = env.LLM_PROFILE !== "demo";

  if (wantsDev && env.DEV_LLM_BASE_URL && env.DEV_LLM_MODEL) {
    return {
      profile: "dev",
      model: env.DEV_LLM_MODEL,
      client: new OpenAI({
        baseURL: env.DEV_LLM_BASE_URL,
        apiKey: env.DEV_LLM_API_KEY || "unused",
      }),
    };
  }

  if (wantsDev) {
    log("warn", "llm", "profile.fallback", {
      reason: "LLM_PROFILE=dev but DEV_LLM_BASE_URL/DEV_LLM_MODEL are unset",
      effect: "using OpenAI — this spends credits",
    });
  }

  return {
    profile: "demo",
    model: env.OPENAI_MODEL,
    client: new OpenAI({ apiKey: env.OPENAI_API_KEY }),
  };
}

/**
 * One structured answer, validated. Used by the research pipeline, where each
 * call is a small self-contained question rather than a conversation. A reply
 * that fails validation is retried once with the error, which is usually all a
 * small dev model needs.
 */
export async function askJson<T>(
  env: Env,
  schema: z.ZodType<T>,
  system: string,
  user: string,
): Promise<{ value: T; tokens: number }> {
  const { client, model } = llmFor(env);
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: `${system}\n\nReply with a single JSON object matching this schema, and nothing else:\n${JSON.stringify(z.toJSONSchema(schema))}` },
    { role: "user", content: user },
  ];

  let tokens = 0;
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await client.chat.completions.create({ model, messages, response_format: { type: "json_object" } });
    tokens += res.usage?.total_tokens ?? 0;
    const raw = res.choices[0].message.content ?? "";
    try {
      return { value: schema.parse(JSON.parse(raw)), tokens };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      messages.push({ role: "assistant", content: raw }, { role: "user", content: `That did not validate: ${lastError.slice(0, 500)}\nSend the corrected JSON object only.` });
    }
  }
  throw new Error(`LLM did not return valid JSON: ${lastError.slice(0, 300)}`);
}
