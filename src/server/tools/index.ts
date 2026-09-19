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
  remember_area: z.object({
    area: z.string().describe("Where this group is based, as specifically as they said it, e.g. 'uptown Waterloo, Ontario'"),
  }),
  remember_name: z.object({
    who: z.string().describe("The speaker label exactly as shown in the transcript, e.g. …4821"),
    name: z.string().describe("What they go by"),
  }),
  research: z.object({
    brief: z
      .string()
      .describe("What the group wants, with every constraint they mentioned: occasion, vibe, budget, dietary needs"),
    near: z.string().describe("Neighbourhood, city or address"),
    when: z.string().optional().describe("Day and time if known, e.g. 'Friday 8pm'"),
    partySize: z.number().int().min(1).optional(),
    depth: z.enum(["quick", "deep"]).describe("quick: ~1 min, a few pages. deep: several minutes, more sources"),
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
  check_availability: z.object({
    optionIds: z.array(z.string()).min(1).max(3).describe("Options from the current plan that have a booking link"),
    partySize: z.number().int().min(1),
    isoTime: z.string().describe("ISO 8601 local date and time the group wants"),
  }),
  book_option: z.object({
    optionId: z.string(),
    partySize: z.number().int().min(1),
    isoTime: z.string().describe("ISO 8601 local time of the reservation"),
    contactName: z.string().describe("Full name the reservation goes under — a real person in the chat, as they gave it"),
    contactEmail: z.string().describe("That person's email, exactly as they typed it. Never invent one."),
    contactPhone: z.string().optional().describe("Their phone number, only if they gave one in the chat. Never invent one."),
  }),
  shop_search: z.object({
    shop: z.string().describe("Shopify store domain, e.g. partycity.com"),
    query: z.string(),
  }),
  shop_build_cart: z.object({
    shop: z.string().describe("The store this cart is at. Every store has its own cart."),
    lines: z
      .array(
        z.object({
          variantId: z.string().describe("variantId exactly as returned by shop_search for THIS shop"),
          quantity: z.number().int().min(1),
        }),
      )
      .min(1)
      .describe("This store's whole cart, not just what changed. Other stores' carts are untouched."),
  }),
  remember_fact: z.object({
    who: z.string().describe("The speaker label exactly as shown in the transcript"),
    fact: z.string().describe("One short durable fact in plain words: 'vegetarian', 'can't do Thursdays', 'lives in Kensington'"),
  }),
  save_profile: z.object({
    name: z.string().optional().describe("What they go by"),
    area: z.string().optional().describe("Neighbourhood or city, exactly as they said it. Do not add a city they did not name."),
    diet: z.string().optional().describe("Food rules in their words, or 'none'"),
    budget: z.string().optional().describe("What a night out costs them, in their words"),
    interests: z.string().optional().describe("Comma-separated, in their words"),
    about: z.string().optional().describe("Anything else lasting they volunteered"),
    matchOptIn: z.boolean().optional().describe("true only if they clearly said yes to being introduced to people"),
    skipped: z
      .array(z.enum(["name", "area", "diet", "budget", "interests", "matchOptIn"]))
      .optional()
      .describe("Questions they declined or said skip to"),
  }),
  send_profile_link: z.object({}),
  forget_person: z.object({
    who: z.string().describe("The speaker label of the person asking to be forgotten"),
  }),
  shop_drop_cart: z.object({
    shop: z.string().describe("The store whose cart to remove from the shopping list"),
  }),
  show_shopping_list: z.object({}),
  mark_paid: z.object({
    who: z.string().describe("Name of the person who said they paid"),
    shop: z.string().describe("Which store's order they paid for, as listed under Shopping list"),
  }),
  show_venue: z.object({
    name: z.string().describe("Venue name as it appears in the research findings or the plan options"),
  }),
  ask_rsvp: z.object({
    title: z.string().optional().describe("Defaults to \"Who's in?\""),
    when: z.string().optional().describe("Short, e.g. 'Fri 8:00 PM'"),
  }),
  record_rsvp: z.object({
    who: z.string().describe("The speaker label exactly as shown in the transcript"),
    answer: z.enum(["in", "out"]),
  }),
  get_rsvps: z.object({}),
  lock_headcount: z.object({}),
  introduce_match: z.object({
    a: z.string().describe("First name of one person"),
    b: z.string().describe("First name of the other"),
    common: z
      .array(z.object({ emoji: z.string().optional().describe("One emoji"), text: z.string().describe("Under 28 characters") }))
      .min(1)
      .max(3)
      .describe("What they share, taken from their own blurbs. Never invented."),
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
  remember_area:
    "Remember where this group is based, as soon as anyone says it. Every later search uses it, so nobody has to repeat it.",
  remember_name: "Remember what a participant goes by, once they or someone else says it.",
  research:
    "Research real options on the live web: reads guides, lists and venue sites, then returns ranked places with sources. Runs in the background for a few minutes and the results arrive on their own — say you're looking into it, then stop. Use it once the group has given you something to go on (what, where, roughly when).",
  propose_plan:
    "Post the plan card with 2-4 concrete options and open voting. Calling it again redraws the same card in place, so use it whenever the options change.",
  get_votes: "Read the current tally and who has not voted yet.",
  check_availability:
    "Open each option's own booking page in a real browser and read which times are actually free for this party size and date. Read-only: it never books or enters details. Takes a minute or two per option and the results arrive on their own — say you're checking, then stop. Use it before a vote when timing matters, or when someone asks if a place has space.",
  book_option:
    "Make a real reservation for the winning option. Only after voting has clearly settled, and only once.",
  shop_search:
    "Search a Shopify store's catalog for things to order (decor, snacks, gifts). Prices come back ready to quote.",
  shop_build_cart:
    "Set ONE store's cart to these contents and post its card with a checkout link for someone to pay. Each store has its own cart, so an event can shop at several: build them one store at a time. Calling it again for the same shop replaces that shop's contents and redraws its card, leaving every other store's cart alone. You never pay yourself.",
  remember_fact:
    "Save something lasting a person said about THEMSELVES (diet, budget, where they live, what they like, when they are free). It follows them into every chat. Never save what someone says about another person, and never save one-off plans.",
  save_profile:
    "Save the profile answers of the person you are talking to. Direct chats only. Include every field their message answered, even several at once. Call it BEFORE send_message.",
  send_profile_link:
    "Send this person their private profile link. Only works in a direct one-to-one chat, because the link is theirs alone.",
  forget_person: "Delete everything saved about a person. Only when that person themselves asks ('forget me').",
  shop_drop_cart: "Remove one store's cart from the shopping list, when the group decides not to order from there after all.",
  show_shopping_list:
    "Post one ticket covering every store's order: what is being bought where, the combined total, the per-person split, and what is still unpaid. Use once the shopping is settled or when someone asks what it all comes to. Not after every cart change.",
  mark_paid:
    "Someone said they paid for one store's order. Posts that store's green PAID ticket. Only when a person in the chat says so, and only for the store they named or clearly meant.",
  show_venue:
    "Post a ticket with one venue's details (what it is, price, address, caveats). Use when someone asks about a specific place. One venue per turn.",
  ask_rsvp:
    "Open a headcount and post the Who's in ticket. People answer with a thumbs up or down on it. Use once a time and place are fixed.",
  record_rsvp: "Record an RSVP that someone gave in words instead of a tapback ('I'm in', 'can't make it').",
  get_rsvps: "Read who is in, who is out and who has not answered.",
  lock_headcount: "Close the headcount and post the final green ticket. It closes on its own once everyone has answered.",
  introduce_match:
    "Post the introduction ticket for two people from the match pool. Both must have opted in, and the things in common must come from their blurbs.",
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
