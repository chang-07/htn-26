/**
 * Secrets are not in wrangler.jsonc, so `wrangler types` cannot see them.
 * Keep this in step with .dev.vars.example. Declared on both interfaces because
 * the generated file defines the global Env and Cloudflare.Env side by side.
 */
interface SecretBindings {
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  SENTRY_RELEASE?: string;
  SENTRY_TRACES_SAMPLE_RATE?: string;
  LINQ_API_KEY: string;
  LINQ_WEBHOOK_SECRET: string;
  /** The line new chats are opened from. Optional: defaults to the key's first number. */
  LINQ_FROM_NUMBER?: string;
  IMESSAGE_TEAM_ID: string;
  IMESSAGE_BUNDLE_ID: string;
  OPENAI_API_KEY: string;
  DEV_LLM_BASE_URL?: string;
  DEV_LLM_API_KEY?: string;
  DEV_LLM_MODEL?: string;
  PUBLIC_BASE_URL: string;
  BROWSERBASE_API_KEY?: string;
  BROWSERBASE_PROJECT_ID?: string;
  AI_GATEWAY_API_KEY?: string;
  JEV_MODEL?: string;
  RESEARCH_MIN_RELEVANCE?: string;
  RESEARCH_MIN_CONFIDENCE?: string;
  /** Persistent context holding the bot account's Instagram login. */
  BROWSERBASE_CONTEXT_ID?: string;
  /** "true" lets the agent really pay. Anything else prices the order and stops. */
  PAYMENTS_LIVE?: string;
  /** The most one purchase may cost, in cents. Defaults to 6000. */
  PAY_CAP_CENTS?: string;
}

interface Env extends SecretBindings {}

declare namespace Cloudflare {
  interface Env extends SecretBindings {}
}
