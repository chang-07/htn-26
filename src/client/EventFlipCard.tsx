import { useRef, useState, type ReactNode } from "react";
import FlipCard from "./motion/FlipCard";
import { ACCENT_PALETTE, PALETTE } from "../theme";
import "./EventFlipCard.css";

type Props = { preview?: ReactNode; actionLabel?: string; title: string; subtitle: string; label: string; image?: string; accent?: string; children: ReactNode };
export function EventFlipCard({ title, subtitle, label, image, accent = ACCENT_PALETTE.pinkSoft, preview, actionLabel = "View details", children }: Props) {
  const [brokenImage, setBrokenImage] = useState<string>();
  const [flipped, setFlipped] = useState(false);
  const frontButton = useRef<HTMLButtonElement>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  function turn(next: boolean) {
    setFlipped(next);
    requestAnimationFrame(() => (next ? backButton : frontButton).current?.focus({ preventScroll: true }));
  }
  return <FlipCard className="event-flip" width={440} height={480} radius={16} background={PALETTE.paper} color={PALETTE.ink} flipped={flipped} onFlipChange={setFlipped} interactiveContent flipOnClick={false} draggable={false} tilt={false} glare={false} hoverScale={1} shadow={false} ariaLabel={title}
    front={<button ref={frontButton} className="event-flip-front" onClick={() => turn(true)} aria-label={`${actionLabel}: ${title}`}>
      <div className={`event-flip-cover${image ? " has-image" : ""}`} style={{ backgroundColor: accent }}>{image && image !== brokenImage ? <img src={image} alt="" onError={() => setBrokenImage(image)} /> : preview ?? <span className="event-flip-type">{title}</span>}<span className="event-flip-label">{label}</span></div>
      <div className="event-flip-caption"><div><p>{subtitle}</p><h2>{title}</h2></div><span className="event-flip-hint">{actionLabel} <span aria-hidden="true">↻</span></span></div>
    </button>}
    back={<div className="event-flip-back"><div className="event-flip-back-head"><h2>{title}</h2><button ref={backButton} onClick={() => turn(false)} aria-label={`Back to ${title}`}>Back</button></div><div className="event-flip-body" data-no-flip>{children}</div></div>}
  />;
}
