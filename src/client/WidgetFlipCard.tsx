import { useState } from "react";
import { EventFlipCard } from "./EventFlipCard";
import { MemoryGame } from "./MemoryGame";
import type { SavedWidget } from "./dashboard-state";
import "./WidgetFlipCard.css";

export function WidgetFlipCard({ widget, onEdit }: { widget: SavedWidget; onEdit: () => void }) {
  const [answer, setAnswer] = useState<string | null>(null);
  const isGame = widget.kind === "Game";
  return <EventFlipCard title={widget.title} subtitle={widget.sample ? "Example widget" : "Your widget"} label={widget.kind} accent={isGame ? "#d5c8ff" : "#a7efd2"} actionLabel={isGame ? "Play" : "Open poll"}
    preview={widget.game === "memory" ? <div className="widget-flip-preview memory" aria-hidden="true"><span>?</span><span>Sun</span><span>Sun</span><span>?</span></div> : <div className="widget-flip-preview choices" aria-hidden="true">{widget.options.slice(0, 3).map(option => <span key={option}>{option}</span>)}</div>}>
    {widget.game === "memory" ? <MemoryGame words={widget.options} /> : <div className="dash-play"><h3>{widget.question}</h3><div className="dash-play-options">{widget.options.map(option => <button key={option} aria-pressed={answer === option} onClick={() => setAnswer(option)}>{option}{answer === option && <span>✓</span>}</button>)}</div><p role="status">{answer ? `You picked ${answer}.` : "Choose an answer."}</p>{answer && <button className="dash-text-button" onClick={() => setAnswer(null)}>Reset</button>}</div>}
    <button className="dash-text-button widget-flip-edit" onClick={onEdit}>Edit widget</button>
  </EventFlipCard>;
}
