# Plan card — design decision

**Decided: direction 01, "ticket stub."** Reference mockups for all four
directions live in [`card-mockups.html`](./card-mockups.html) (open it in a
browser) and at https://claude.ai/artifact/DQ2NjiMeKqf5kaL9gqqTkj

The ticket won because it reads as a physical object rather than a UI, and
because the tear-off stub gives the booked state an obvious place to land — the
card redraws in the same bubble as the plan progresses, so the design had to
survive that transition, not just look good in one frame.

## What we actually control

The card is a Linq `imessage_app` part. Only `layout.image_url` is ours — a PNG
we render and host. Everything else is Apple's chrome, in Apple's font:

| Field | Ours? | Notes |
|---|---|---|
| `image_url` | **yes** | The design. Renders for all recipients, app installed or not. |
| `image_title` / `image_subtitle` | no | Apple overlays these *on* the image. **Leave unset** — they collide with our own type. |
| `caption` / `subcaption` | text only | Bottom-left. Not stylable. |
| `trailing_caption` / `trailing_subcaption` | text only | Bottom-right. Not stylable. |
| app icon | no | Fixed to the Messages extension's icon. |

Source: doc comments on `Message.IMessageAppPartResponse.Layout` in
`node_modules/@linqapp/sdk/resources/messages/messages.d.ts`.

## The ticket spec

Two states, one system. State is carried by the ground colour.

|  | Vote | Booked |
|---|---|---|
| Ground | `#faf9f6` paper | `#84efc4` teal |
| Ink | `#282827` | `#153c30` |
| Perforation | ink @ 32% | ink @ 30% |

Values are `PALETTE` in `src/theme.ts`; `card.ts`, `Landing.css` and `DesignSystem.swift` read from or match it.

- **Display face** — Archivo 800. Headline 23px/1.0, `-0.02em`, max-width 195px.
  Stub numeral 20px.
- **Detail face** — IBM Plex Mono. Meta row 9.5px, `0.13em`, uppercase, 62%
  opacity. Option rows 11px/500 with a 15px emoji gutter and 7px gap.
  Stub label 8.5px, `0.1em`, uppercase, 60% opacity.
- **Geometry** — 14px/16px padding. Stub is a 58px column on the right, with the
  perforation at `right: 58px`: 2px wide, dot radius 1.1px, 9px pitch.
- **Content** — venue names need ~246px to stay on one line. "Death Valley's
  Little Brother" is the stress case; anything longer wraps and the row block
  grows by a third.

Caption rows per state:

```
vote    caption "Friday plan"  subcaption "React to vote"
        trailing "3" / "options"
booked  caption "Booked"       subcaption "<venue>"
        trailing "8:00 PM" / "Fri"
```

## Porting to Satori (`workers-og`)

The mockups are HTML. Satori is **flexbox only**, so two things don't port:

1. **The perforation** is a `radial-gradient` background. Satori has no gradient
   backgrounds — rebuild it as a flex column of ~24 dots (2x2px, 7px gap).
2. **No `aspect-ratio`.** Set explicit `width`/`height` on the `ImageResponse`.

`position: absolute` does work, so the stub can stay as-is.

## Open questions

- **Card aspect ratio is unconfirmed.** Mockups assume 3:2 (360x240); the SDK
  docs give no dimensions. Until it's measured on a real device, keep anything
  load-bearing away from the edges — the right-hand stub is the most exposed
  element if Apple crops to a different ratio.
- **`image_url` requires "a trusted chat w/ inbound activity"** (SDK docs
  verbatim). The image will not render into a cold thread until someone has
  texted the number first. Sequencing constraint for demo day.
