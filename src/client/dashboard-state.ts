import { dashboardSchema, type DashboardState } from "../shared/workspace";
export { dashboardSchema, type DashboardState, type SavedWidget, type Friend } from "../shared/workspace";
export const DASHBOARD_KEY = "whim.dashboard.v1";
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
