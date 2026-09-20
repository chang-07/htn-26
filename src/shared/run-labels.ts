import type { RunSummary } from "../server/runs";

const actions: Record<string, string> = {
  send_message: "Send a reply", research: "Research outing options", propose_plan: "Present plan options",
  get_votes: "Review group votes", check_availability: "Check availability", book_option: "Attempt a reservation",
  shop_search: "Search for products", shop_build_cart: "Build a shopping cart", shop_drop_cart: "Remove a shopping cart",
  set_delivery: "Set delivery details", show_shopping_list: "Show the shopping list", mark_paid: "Record a payment",
  add_expense: "Add an expense", drop_expense: "Remove an expense", show_invoice: "Show the cost breakdown",
  show_venue: "Show venue details", ask_rsvp: "Ask who is attending", record_rsvp: "Record an RSVP",
  get_rsvps: "Review RSVPs", lock_headcount: "Confirm the group size", request_location: "Ask for a location",
  read_locations: "Check shared locations", remember_area: "Save the meeting area", remember_name: "Save a name",
  remember_fact: "Save a preference", save_profile: "Update a profile", send_profile_link: "Share the profile form",
  forget_person: "Remove saved personal details", introduce_match: "Introduce a group match",
  join_match_pool: "Join group matching", find_matches: "Find group matches", request_intro: "Request an introduction",
  answer_intro: "Respond to an introduction",
};
const triggers: Record<string, string> = {
  "message.in": "Message received", "message.stored": "Message saved for context", "message.duplicate": "Duplicate message skipped",
  "message.out": "Reply sent to the chat", "reaction.ignored": "Reaction not matched to an action", "reaction.sent": "Reaction sent to the chat",
  "vote.cast": "Group vote recorded", "vote.ignored": "Vote not counted", "location.requested": "Location requested",
  "location.sharing_started": "Live location sharing started", "location.taken": "Shared location received",
  "research.started": "Venue research started", "research.finished": "Research results received",
  "booking.started": "Reservation attempt started", "booking.finished": "Reservation result received",
  "pay.asked": "Checkout requested", "pay.finished": "Checkout result received", "profile.saved_via_form": "Profile form submitted",
  "person.forgotten": "Saved personal details removed", "links.forgotten": "Saved social links removed", "dev.tool": "Manual tool test",
};
const humanize = (text: string) => text.replace(/[._]/g, " ").replace(/^./, (c) => c.toUpperCase());

/** Describe recorded intent, never infer that a purchase or reservation succeeded. */
export function runLabel(run: Pick<RunSummary, "said" | "tools" | "trigger" | "outcome">) {
  const message = run.said?.trim().replace(/\s+/g, " ").replace(/\S+@\S+/g, "(email)") ?? "";
  const tools = [...new Set(run.tools ?? [])];
  const substantive = tools.filter((tool) => tool !== "send_message");
  const labels = substantive.map((tool) => actions[tool] ?? humanize(tool));
  let title: string;
  if (message && message.length <= 40 && labels.length) title = labels[0];
  else if (message && message.length <= 40) title = `${run.outcome === "replied" ? "Reply to" : "Message:"} “${message}”`;
  else if (message) title = message;
  else if (labels.length) title = labels[0];
  else if (run.trigger === "reaction.ignored" && tools.includes("send_message")) title = "Respond to a message reaction";
  else title = triggers[run.trigger ?? ""] ?? (run.trigger ? humanize(run.trigger) : "Agent activity");
  const details = [
    message && !title.includes(message) ? `“${message}”` : null,
    ...labels.filter((label) => label !== title),
  ].filter(Boolean) as string[];
  return { title, detail: details.slice(0, 3).join(" · ") };
}
