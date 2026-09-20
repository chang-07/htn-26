import { dashboardSchema, type DashboardState } from "../shared/workspace.ts";
export { dashboardSchema, type DashboardState, type SavedWidget, type Friend } from "../shared/workspace.ts";
export const DASHBOARD_KEY = "whim.dashboard.v1";
export const initialDashboard: DashboardState = {
  account: { name: "", city: "", food: "", budget: "Flexible" },
  friends: [], plans: [],
  widgets: [],
};
export function readDashboard(value: string | null): DashboardState {
  if (!value) return structuredClone(initialDashboard);
  try { const result = dashboardSchema.safeParse(JSON.parse(value)); if (result.success) {
    result.data.widgets = result.data.widgets.filter(w => !w.sample);
    return result.data;
  } } catch { /* Reset malformed local data. */ }
  return structuredClone(initialDashboard);
}
