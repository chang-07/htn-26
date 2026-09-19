import { z } from "zod";

/**
 * Tool contracts. The JSON Schema sent to the model is generated from the same
 * zod schema that validates the model's arguments, so the two cannot drift.
 * Execution lives on the agent (agent.ts), which owns the state these touch.
 */
export const toolSchemas = {
  send_message: z.object({
    text: z.string().describe("One or two short lines. This is a group text."),
  }),
  remember_name: z.object({
    who: z.string().describe("The speaker label exactly as shown in the transcript, e.g. …4821"),
    name: z.string().describe("What they go by"),
  }),
  search_places: z.object({
    query: z.string().describe("e.g. 'ramen', 'bowling', 'rooftop bar'"),
    near: z.string().describe("Neighbourhood, city or address"),
  }),
  propose_plan: z.object({
    title: z.string().describe("Short, e.g. 'Friday dinner'"),
    options: z
      .array(
        z.object({
          title: z.string(),
          subtitle: z.string().optional().describe("Time, price, vibe — one line"),
          bookingUrl: z.string().optional(),
        }),
      )
      .min(2)
      .max(4),
  }),
  get_votes: z.object({}),
  book_option: z.object({
    optionId: z.string(),
    partySize: z.number().int().min(1),
    isoTime: z.string().describe("ISO 8601 local time of the reservation"),
  }),
  shop_search: z.object({
    shop: z.string().describe("Shopify store domain, e.g. allbirds.com"),
    query: z.string(),
  }),
  shop_build_cart: z.object({
    shop: z.string(),
    lines: z
      .array(
        z.object({
          variantId: z.string().describe("Variant id from shop_search results"),
          title: z.string(),
          quantity: z.number().int().min(1),
        }),
      )
      .min(1),
  }),
  join_match_pool: z.object({
    who: z.string().describe("Transcript label of the person opting in"),
    blurb: z.string().describe("Their interests, in their own words"),
  }),
  find_matches: z.object({
    blurb: z.string().describe("Interests to match against"),
  }),
} as const;

export type ToolName = keyof typeof toolSchemas;

const descriptions: Record<ToolName, string> = {
  send_message: "Send a plain text message to the group chat.",
  remember_name: "Remember what a participant goes by, once they or someone else says it.",
  search_places: "Find venues, restaurants or activities near a location.",
  propose_plan:
    "Post the plan card with 2-4 concrete options and open voting. Calling it again redraws the same card in place, so use it whenever the options change.",
  get_votes: "Read the current tally and who has not voted yet.",
  book_option:
    "Make a real reservation for the winning option. Only after voting has clearly settled, and only once.",
  shop_search: "Search a Shopify store's catalog for things to order (decor, snacks, gifts).",
  shop_build_cart:
    "Build a Shopify cart and post its checkout link to the chat for someone to pay. You never pay yourself.",
  join_match_pool:
    "Add someone to the matchmaking pool. Only when that person has explicitly asked to be included.",
  find_matches: "Find people in the opt-in pool with similar interests.",
};

export function openAiTools() {
  return (Object.keys(toolSchemas) as ToolName[]).map((name) => ({
    type: "function" as const,
    function: {
      name,
      description: descriptions[name],
      parameters: z.toJSONSchema(toolSchemas[name]) as Record<string, unknown>,
    },
  }));
}

export function parseToolArgs<N extends ToolName>(
  name: N,
  rawJson: string,
): z.infer<(typeof toolSchemas)[N]> {
  return toolSchemas[name].parse(JSON.parse(rawJson || "{}")) as z.infer<(typeof toolSchemas)[N]>;
}
