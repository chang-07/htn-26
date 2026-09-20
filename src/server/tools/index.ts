import { z } from "zod";
import { locationArgs, weatherArgs } from "../weather";

/**
 * Tool contracts. The JSON Schema sent to the model is generated from the same
 * zod schema that validates the model's arguments, so the two cannot drift.
 * Execution lives on the agent (agent.ts), which owns the state these touch.
 */
export const toolSchemas = {
  find_locations: locationArgs,
  get_weather: weatherArgs,
  send_message: z.object({
    text: z.string().describe("One or two short lines. This is a group text."),
  }),
  remember_area: z.object({
    area: z.string().describe("Where this group is based, as specifically as they said it, e.g. 'uptown Waterloo, Ontario'"),
  }),
  request_location: z.object({}),
  read_locations: z.object({}),
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
    emoji: z.string().optional().describe("ONE emoji for the outing: 🍜 ramen, 🎳 bowling, 🧗 climbing. It badges the group chat once the plan is booked."),
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
    optionIds: z.array(z.string()).max(3).optional().describe("Ballot options to check, by id"),
    venues: z
      .array(z.object({ title: z.string(), bookingUrl: z.string().describe("The venue's bookingUrl exactly as research returned it") }))
      .max(3)
      .optional()
      .describe("Places that are part of the outing but not on the ballot (the spa after dinner), from the Research findings"),
    partySize: z.number().int().min(1),
    isoTime: z.string().describe("ISO 8601 local date and time the group wants"),
  }),
  book_option: z.object({
    optionId: z.string().optional().describe("The ballot option to book. Omit when booking a venue that is not on the ballot."),
    venue: z
      .object({ title: z.string(), bookingUrl: z.string().describe("Exactly as research returned it") })
      .optional()
      .describe("A place that is part of the outing but not on the ballot, from the Research findings"),
    partySize: z.number().int().min(1),
    isoTime: z.string().describe("ISO 8601 local time of the reservation"),
    contactName: z.string().optional().describe("Full name the reservation goes under — a real person in the chat, as they gave it. Required for a restaurant or venue reservation only."),
    contactEmail: z.string().optional().describe("That person's email, exactly as they typed it. Never invent one. Required for a restaurant or venue reservation only."),
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
    links: z
      .array(z.string())
      .max(6)
      .optional()
      .describe("Socials or links exactly as they gave them: '@chang on instagram', 'letterboxd.com/chang', a site. Never guess or complete a handle."),
    matchOptIn: z.boolean().optional().describe("true only if they clearly said yes to being introduced to people"),
    skipped: z
      .array(z.enum(["name", "area", "diet", "budget", "interests", "links", "matchOptIn"]))
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
  set_delivery: z.object({
    to: z
      .enum(["event", "venue", "payer"])
      .describe("event: one address for the whole event, typed by the first person to pay. venue: the same, prefilled with a researched venue's address. payer: back to each order shipping to whoever pays for it."),
    venue: z.string().optional().describe("With to=venue: the venue's exact name from the Research findings"),
  }),
  mark_paid: z.object({
    who: z.string().describe("Name of the person who said they paid"),
    shop: z.string().describe("Which store's order they paid for, as listed under Shopping list"),
  }),
  add_expense: z.object({
    who: z.string().describe("The speaker label of the person who paid, exactly as shown in the transcript"),
    amount: z.string().describe("The amount exactly as they said it, with the currency sign if they gave one: '$86.40', '20'"),
    what: z.string().describe("What it was for, in a few words: 'dinner at Kinton', 'the deposit', 'cab home'"),
    for: z
      .array(z.string())
      .max(12)
      .optional()
      .describe("Speaker labels or names this is split across. Omit for everyone going. ONE name when they paid that person back."),
  }),
  drop_expense: z.object({
    id: z.string().describe("The expense id as listed under Invoice"),
  }),
  show_invoice: z.object({}),
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
    who: z.string().describe("Transcript label of the person who asked to be paired up"),
    lookingFor: z
      .string()
      .optional()
      .describe("What they said they want, in their words: 'someone to climb with', 'a board game group'. Omit to match on their whole profile."),
    near: z.string().optional().describe("A place they named for this search ('Vancouver'), when it is not where they live. Omit it unless they named a place in this message: never fill in their own city. People based there come first."),
  }),
  request_intro: z.object({
    candidate: z.string().describe("The ref of one candidate from find_matches, e.g. c1"),
    common: z
      .array(z.object({ emoji: z.string().optional().describe("One emoji"), text: z.string().describe("Under 28 characters") }))
      .min(1)
      .max(3)
      .describe("What the two share, taken from the asker's profile and the candidate's blurb. Never invented."),
  }),
  answer_intro: z.object({
    answer: z.enum(["yes", "no"]).describe("Their answer to the pending introduction"),
  }),
  add_song: z.object({
    title: z.string().describe("Song title as they said it"),
    artist: z.string().optional().describe("Artist if they named one"),
    who: z.string().optional().describe("The speaker label of whoever asked for it"),
  }),
  show_playlist: z.object({}),
  search_flights: z.object({
    from: z.string().min(2).max(40).describe("Airport code or city, e.g. YYZ or Toronto"),
    to: z.string().min(2).max(40),
    depart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("YYYY-MM-DD"),
    return: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD; omit for one way"),
    adults: z.number().int().min(1).max(9).optional(),
  }),
  search_stays: z.object({
    where: z.string().min(2).max(60).describe("City or neighbourhood, e.g. downtown Vancouver"),
    checkin: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    checkout: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    adults: z.number().int().min(1).max(9).optional(),
  }),
  find_events: z.object({
    city: z.string().min(2).max(60),
    query: z.string().max(80).optional().describe("A team, artist or show for ticketed events. Omit for what's on in the city."),
    country: z.string().length(2).optional().describe("ISO country, default CA"),
  }),
  add_to_itinerary: z.object({
    optionId: z.string().optional().describe("The winning ballot option"),
    item: z
      .object({
        kind: z.enum(["flight", "stay", "event", "venue"]),
        title: z.string(),
        subtitle: z.string().optional(),
        url: z.string().optional(),
        price: z.string().optional(),
      })
      .optional()
      .describe("Something settled without a vote, e.g. the one flight everyone agreed on in text"),
    kind: z.enum(["flight", "stay", "event", "venue"]).optional().describe("What the winning option is, when it is a ballot option. Inferred from the option's link when omitted; only a plain venue link needs it said."),
  }),
  watch_flight: z.object({
    ident: z.string().min(3).max(8).describe("Airline code and number, e.g. AC123"),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    itemId: z.string().optional().describe("The itinerary item this flight is, if any"),
  }),
  confirm_item: z.object({
    itemId: z.string(),
    note: z.string().max(60).optional().describe("Confirmation number or what they said"),
    price: z.string().optional().describe("What was paid, as they said it, e.g. 'CA$254'"),
    paidBy: z.string().optional().describe("Who paid, as they are shown in the transcript"),
  }),
  make_game: z.object({
    topic: z.string().optional().describe("What the game should be about, in the asker's words. When they named none (\"let's play a game\"), one you picked from what this chat is about."),
  }),
} as const;

export type ToolName = keyof typeof toolSchemas;

const descriptions: Record<ToolName, string> = {
  find_locations: "Resolve a named city or postal code to locations and timezones. Include the known province/country. Ask the user when multiple results fit. This does not access anyone’s live location.",
  get_weather: "Get a daily forecast for a locationId returned by find_locations and the outing’s local YYYY-MM-DD date. Use for outdoor/weather-sensitive plans or explicit weather questions, not every dinner. Never guess a location id or substitute another date.",
  send_message: "Send a plain text message to the group chat.",
  remember_area:
    "Remember where this group is based, as soon as anyone says it. Every later search uses it, so nobody has to repeat it.",
  request_location:
    "One-to-one chats only, and only after the person has said yes to sharing. Sends their phone a prompt to share location; when they accept, the city is remembered as their area on its own and the share is ended straight away — nothing is tracked. After calling it, say one line and stop. If it is refused, ask them to type where they are instead.",
  read_locations:
    "Read where the people in this chat are, for anyone sharing their location with you. Works in groups and one-to-one. Returns each person's city and how far apart they are. Call it whenever someone says they shared their location, or asks anything that depends on where people are: how far apart they are, what is between them, what is near them.",
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
    "Search a Shopify store's catalog for things to order (decor, snacks, gifts, clothes). Prices come back ready to quote.",
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
  set_delivery:
    "Choose where this event's orders ship. Only when someone in the chat says so: 'send it all to the party', 'ship it to my place for everyone' (event), or explicitly asks for it to go to the venue (venue). You never see or handle the address: whoever pays checks it on a private form first.",
  show_shopping_list:
    "Post one ticket covering every store's order: what is being bought where, the combined total, the per-person split, and what is still unpaid. Use once the shopping is settled or when someone asks what it all comes to. Not after every cart change.",
  mark_paid:
    "Someone said they paid for one store's order. Posts that store's green PAID ticket. Only when a person in the chat says so, and only for the store they named or clearly meant.",
  add_expense:
    "Log money a person paid that did not go through a cart: the bill, a deposit, the cab, or paying someone back. Only when that person, or someone in the chat, says so with an amount; never a guess. Paying someone back is an expense with `for` set to that one person. It joins the invoice at once.",
  drop_expense: "Remove one logged expense from the invoice, by its id, when it was wrong or the person takes it back.",
  show_invoice:
    "Post the invoice ticket: who paid what and who owes whom, worked out from every cart and logged expense across everyone going. Use when someone asks what they owe or how to split it. It posts itself once every cart is paid, so not after every change.",
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
  find_matches:
    "Search the opt-in pool for people to pair someone up with. The asker must be in the pool themselves. Candidates come back with a ref and a blurb but no name: describe them to the asker, never identify them.",
  request_intro:
    "Ask one candidate, privately in their own chat, whether they want to be introduced. Only after the asker picked that candidate. The asker hears back when they answer.",
  answer_intro:
    "Record this person's yes or no to the pending introduction shown in your context. Call it FIRST, before send_message. On yes a group chat is opened for the two of them.",
  add_song:
    "Add a song someone named to the group playlist. It is looked up on iTunes, so pass the title (and artist when given) as they said it — never invent songs nobody asked for. The playlist card in the thread updates on its own.",
  show_playlist:
    "Post (or repost) the playlist card so the group can open the player. Use when someone asks to see or play the playlist and there is no card in recent view.",
  search_flights:
    "Real flights from Google Flights, cheapest first, back in this turn. Each result is shaped as a ballot option with its price: put 2-4 on propose_plan. The link opens the airline's own checkout on their phone: you never book flights. Dates as YYYY-MM-DD; ask if the group has not said when.",
  search_stays:
    "Real hotels from Google Hotels for a city and dates, cheapest first, back in this turn, shaped as ballot options with nightly prices. Same rules as flights: propose, never book.",
  find_events:
    "What's on: with a query (a team, an artist, a show) it reads Ticketmaster for real dates, venues and on-sale status; without one it lists the city's upcoming events from Luma. Back in this turn, shaped as ballot options.",
  add_to_itinerary:
    "Once a vote has clearly settled (check get_votes), record the winner as a stop on the trip. It posts the itinerary ticket, gives the group the link to finish it, and clears the ballot so the next segment (the hotel, the game) can open. Say kind for a ballot option, or pass item for something agreed in text.",
  watch_flight:
    "When someone gives a flight number (AC123), read its live status now and keep watching: gate, delay, departed, landed are posted on their own from 36 hours before departure. Pass itemId when it is a stop on the itinerary.",
  confirm_item:
    "When a person says they booked or paid for an itinerary stop, mark it confirmed. With price and paidBy it also logs the expense so the invoice splits it.",
  make_game:
    "Generate a trivia game and post its card. Call it for any ask to play a game, with or without a topic. Takes ~10 seconds; the card handles joining and playing. Never recite the questions in chat.",
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
