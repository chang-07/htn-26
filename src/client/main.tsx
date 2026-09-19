import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Widget } from "./Widget";
import { Runs } from "./Runs";

function App() {
  // /w/<agent name> — the agent name is the Linq chat id, which doubles as an
  // unguessable capability for the vote page.
  // /runs — the agent-run viewer. Full-bleed, so it skips Shell.
  if (window.location.pathname.startsWith("/runs")) return <Runs />;

  const match = window.location.pathname.match(/^\/w\/(.+)$/);
  if (!match) {
    return (
      <Shell>
        <main style={{ padding: 28, fontFamily: "ui-monospace, Menlo, monospace", color: "#241f17", background: "#efe7d6", minHeight: "100vh" }}>
          The planner lives in the group chat.
        </main>
      </Shell>
    );
  }
  return (
    <Shell>
      <Widget agentName={decodeURIComponent(match[1])} />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  // The ticket pages style themselves (see src/theme.ts); nothing to add here.
  return <>{children}</>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
