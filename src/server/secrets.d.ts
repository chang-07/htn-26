/**
 * Secrets are not in wrangler.jsonc, so `wrangler types` cannot see them.
 * Keep this in step with .dev.vars.example. Declared on both interfaces because
 * the generated file defines the global Env and Cloudflare.Env side by side.
 */
interface SecretBindings {
  LINQ_API_KEY: string;
  LINQ_WEBHOOK_SECRET: string;
  IMESSAGE_TEAM_ID: string;
  IMESSAGE_BUNDLE_ID: string;
  OPENAI_API_KEY: string;
  DEV_LLM_BASE_URL?: string;
  DEV_LLM_API_KEY?: string;
  DEV_LLM_MODEL?: string;
  PUBLIC_BASE_URL: string;
  BROWSERBASE_API_KEY?: string;
  BROWSERBASE_PROJECT_ID?: string;
}

interface Env extends SecretBindings {}

declare namespace Cloudflare {
  interface Env extends SecretBindings {}
}
