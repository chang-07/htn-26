import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Widget } from "./Widget";

function App() {
  // /w/<agent name> — the agent name is the Linq chat id, which doubles as an
  // unguessable capability for the vote page.
  const match = window.location.pathname.match(/^\/w\/(.+)$/);
  if (!match) {
    return (
      <Shell>
        <h1 style={{ fontSize: 24 }}>Plan</h1>
        <p style={{ color: "#9C9CAC" }}>The UI lives in the group chat.</p>
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
  return (
    <main
      style={{
        padding: 24,
        maxWidth: 560,
        margin: "0 auto",
        color: "#FAFAFA",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
      }}
    >
      {children}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
