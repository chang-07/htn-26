import OpenAI from "openai";

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
    console.warn(
      "[llm] LLM_PROFILE=dev but DEV_LLM_BASE_URL/DEV_LLM_MODEL are unset — falling back to OpenAI (this spends credits)",
    );
  }

  return {
    profile: "demo",
    model: env.OPENAI_MODEL,
    client: new OpenAI({ apiKey: env.OPENAI_API_KEY }),
  };
}
