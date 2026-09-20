import { z } from "zod";

const friendSchema = z.object({ id: z.string().max(2000), name: z.string().max(2000), food: z.string().max(2000), budget: z.string().max(2000) });
const widgetSchema = z.object({ id: z.string().max(2000), title: z.string().max(2000), question: z.string().max(2000), options: z.array(z.string().max(2000)).min(2).max(100), kind: z.enum(["Poll", "Game"]), sample: z.boolean().default(false), game: z.literal("memory").optional() });
export const dashboardSchema = z.object({
  account: z.object({ name: z.string().max(2000), city: z.string().max(2000), food: z.string().max(2000), budget: z.string().max(2000) }),
  friends: z.array(friendSchema).max(200),
  widgets: z.array(widgetSchema).max(200),
  plans: z.array(z.object({ id: z.string().max(2000), agent: z.string().max(2000) })).max(200),
});
export type DashboardState = z.infer<typeof dashboardSchema>;
export type SavedWidget = DashboardState["widgets"][number];
export type Friend = DashboardState["friends"][number];
