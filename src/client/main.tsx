import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Widget } from "./Widget";
import { Runs } from "./Runs";
import { Landing } from "./Landing";
import { AccountDashboard } from "./Account";

function App() {
  // /w/<agent name> — the agent name is the Linq chat id, which doubles as an
  // unguessable capability for the vote page.
  // /runs — the agent-run viewer, full-bleed.
  // Anything else — the front page. The planner lives in the chat; this is
  // where someone who only has the URL finds out what it is.
  if (window.location.pathname === "/dashboard" || window.location.pathname.startsWith("/dashboard/")) return <AccountDashboard />;
  if (window.location.pathname.startsWith("/runs")) return <Runs />;

  const match = window.location.pathname.match(/^\/w\/(.+)$/);
  if (match) return <Widget agentName={decodeURIComponent(match[1])} />;
  return <Landing />;
}

// Vite can re-evaluate this entry during hot updates. Keep the existing root
// so there is only one React tree attached to the container.
const container = document.getElementById("root");
if (!container) throw new Error("Missing React root container");
const root: Root = import.meta.hot?.data.root ?? createRoot(container);
if (import.meta.hot) import.meta.hot.data.root = root;

root.render(
  <StrictMode>
    <App />
  </StrictMode>,
);
