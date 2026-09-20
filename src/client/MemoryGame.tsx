import { useEffect, useState } from "react";
import "./MemoryGame.css";
export function makeDeck(words: string[], random = Math.random) {
  const pairs = [...new Set(words)].slice(0, 8);
  const deck = [...pairs, ...pairs].map((word, id) => ({ word, id }));
  for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
  return deck;
}
export function MemoryGame({ words }: { words: string[] }) {
  const [deck, setDeck] = useState(() => makeDeck(words));
  const [open, setOpen] = useState<number[]>([]);
  const [matched, setMatched] = useState<string[]>([]);
  const [moves, setMoves] = useState(0);
  const complete = matched.length * 2 === deck.length;
  useEffect(() => {
    if (open.length !== 2) return;
    const timer = setTimeout(() => {
      if (deck[open[0]].word === deck[open[1]].word) setMatched(old => [...old, deck[open[0]].word]);
      setOpen([]);
    }, deck[open[0]].word === deck[open[1]].word ? 250 : 850);
    return () => clearTimeout(timer);
  }, [open, deck]);
  function pick(index: number) {
    if (open.length === 2 || open.includes(index) || matched.includes(deck[index].word)) return;
    if (open.length === 1) setMoves(n => n + 1);
    setOpen(old => [...old, index]);
  }
  return <div className="memory-game"><div className="memory-score"><span>{matched.length} / {deck.length / 2} pairs</span><span>{moves} moves</span></div><div className="memory-board">{deck.map((tile, index) => {
    const found = matched.includes(tile.word); const visible = open.includes(index) || found;
    return <button key={tile.id} className={found ? "matched" : visible ? "revealed" : ""} disabled={found || open.includes(index) || open.length === 2} onClick={() => pick(index)} aria-label={visible ? `${tile.word}${found ? ', matched' : ''}` : `Reveal tile ${index + 1}`}>{visible ? tile.word : <span aria-hidden="true">?</span>}</button>;
  })}</div><p role="status">{complete ? `All matched in ${moves} moves.` : "Find the pairs. Pass the phone and beat each other’s score."}</p><button className="memory-reset" onClick={() => { setDeck(makeDeck(words)); setOpen([]); setMatched([]); setMoves(0); }}>Play again</button></div>;
}
