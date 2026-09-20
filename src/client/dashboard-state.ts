import { z } from "zod";

export const DASHBOARD_KEY = "whim.dashboard.v1";
const friendSchema = z.object({ id: z.string(), name: z.string(), food: z.string(), budget: z.string() });
const widgetSchema = z.object({ id: z.string(), title: z.string(), question: z.string(), options: z.array(z.string()).min(2), kind: z.enum(["Poll", "Game"]), sample: z.boolean().default(false), game: z.literal("memory").optional() });
export const dashboardSchema = z.object({
  account: z.object({ name: z.string(), city: z.string(), food: z.string(), budget: z.string() }),
  friends: z.array(friendSchema),
  widgets: z.array(widgetSchema),
  plans: z.array(z.object({ id: z.string(), agent: z.string() })),
});
export type DashboardState = z.infer<typeof dashboardSchema>;
export type SavedWidget = DashboardState["widgets"][number];
export type Friend = DashboardState["friends"][number];
export const initialDashboard: DashboardState = {
  account: { name: "", city: "", food: "", budget: "Flexible" },
  friends: [], plans: [],
  widgets: [
    { id: "sample-memory", title: "Match pairs", question: "A quick memory game for your group.", options: ["Moon", "Sun", "Wave", "Star", "Leaf", "Rain"], kind: "Game", game: "memory", sample: true },
    { id: "sample-poll", title: "What’s for dinner?", question: "What are we eating on Friday?", options: ["Pizza", "Ramen", "Tacos"], kind: "Poll", sample: true },
  ],
};
export function readDashboard(value: string | null): DashboardState {
  if (!value) return structuredClone(initialDashboard);
  try { const result = dashboardSchema.safeParse(JSON.parse(value)); if (result.success) {
    result.data.widgets = result.data.widgets.map(w => w.id === "sample-game" && w.sample ? structuredClone(initialDashboard.widgets[0]) : w);
    return result.data;
  } } catch { /* Reset malformed local data. */ }
  return structuredClone(initialDashboard);
}
