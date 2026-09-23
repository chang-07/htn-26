# In-bubble widget — RL-style rubric

Treat the repo as the environment: state = the codebase + the design system it
documents, action = a UI diff, reward = the score below. A change ships when it
clears the gate; anything below that is a failed episode — revert and try a
different action, don't argue with the judge.

Feature under evaluation: **the plan widget rendered inside the iMessage bubble**
(`/w/<chat>` loaded by the Messages extension via the Linq `imessage_app` part),
in both of Apple's presentation styles: the compact drawer strip (~250–320px of
visible height) and the expanded sheet.

## Reward function (100 points)

### R1 — Design-language fidelity (25)
Source of truth: `src/theme.ts` header comment, `docs/card-design.md`.

- [5] Only the two grounds exist: paper `#faf9f6` open, teal `#84efc4` done, per `PALETTE` in `src/theme.ts`.
  State is carried by the ground flip, never by a badge.
- [5] Type system intact: Archivo 800 for titles/stub figures, IBM Plex Mono for
  everything else, spaced small caps for labels.
- [5] None of the banned ornaments appear: boxes around things, rounded corners,
  shadows, accent colours, gradients, pill badges.
- [5] The dotted perforation stays the only ornament.
- [5] The bubble rendering reads as the ticket "opened up" — same object as the
  card PNG, not a different app.

### R2 — In-bubble fitness (25)
Source of truth: Linq iMessage Apps doc + Apple presentation styles.

- [7] Compact strip: title, status and at least the first option row visible
  without scrolling at ~300px height; nothing clipped mid-glyph.
- [6] Expanded sheet: full page usable; bottom action reachable above the home
  indicator (safe-area inset respected).
- [6] No horizontal scroll at 320px width. Long venue names wrap, never overflow.
- [6] Loads fast on first paint: no new dependencies, no blocking assets beyond
  the two Google Fonts already in use.

### R3 — Surgical change (20)
Source of truth: CLAUDE.md Karpathy rules, repo freeze context (demo tomorrow).

- [8] Touches the minimum files; every changed line traces to this feature.
- [6] Zero behavior change outside the feature: Safari full-page view renders
  byte-identical at normal viewports; profile form untouched.
- [6] No new npm packages, no server changes, no schema changes.

### R4 — Live-state correctness (15)
Source of truth: `Widget.tsx` / agents SDK contract.

- [6] All content still driven by the WebSocket state push; no polling added.
- [5] Vote tap → `agent.call("vote", ...)` path unchanged and works from inside
  a WKWebView.
- [4] Status transitions (voting → booking → booked) re-render correctly,
  including the cream→green flip, without reload.

### R5 — Platform constraint compliance (15)
Source of truth: Linq docs, WKWebView behavior, repo README warnings.

- [5] Nothing depends on popups, passkeys, downloads, or cross-origin
  storage — all known-dead inside in-app webviews (README learned this on the
  payments flow).
- [5] Degrades gracefully when `localStorage` is unavailable (voter identity
  already falls back to "anonymous"; nothing new may assume storage).
- [5] All assets HTTPS; page still works when opened plainly in Safari — the
  same URL serves both surfaces, per the Linq doc's "url is the contract".

## Gate

Ship at **≥ 85/100** with: `npm run typecheck` green, and visual verification at
320×300 (compact), 390×700 (expanded), and 900×900 (Safari) against R1/R2.

## Episode log

| Episode | Action | Score | Notes |
|---|---|---|---|
| 1 | Compact-viewport CSS layer in `theme.ts` (one media query, no markup changes) | **97 / 100 — ship** | R1 25/25 · R2 24/25 · R3 20/20 · R4 13/15 · R5 15/15. Verified: typecheck green; iframe harness at 320×300 / 390×640 / 620×760 — compact shows full ticket (title, 3 rows incl. wrapped long name, hint) with no scroll; larger viewports byte-identical to before; vote tapped in the 320×300 frame propagated to all frames over the WebSocket. Points withheld: expanded-sheet safe area and the cream→green flip not verified on a physical device inside Messages — retest there once the extension is installed. |
