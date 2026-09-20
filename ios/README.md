# Plan — iMessage extension

Renders the htn-26 widget (`/w/<chat>`) inside the Messages bubble. The Linq
`imessage_app` part carries a `url`; this extension loads it in a WKWebView.
Change what the server sends, change the app — no rebuild.

## Identity (goes in the worker's secrets)

```
IMESSAGE_TEAM_ID=B2F6TWN8SZ
IMESSAGE_BUNDLE_ID=com.lukalavric.plan.MessagesExtension
```

Set both with `npx wrangler secret put` on the htn-26 worker and
`hasAppIdentity()` switches sends from Linq experiences to app cards on its own.

## Build

Project is generated — edit `project.yml`, not the .xcodeproj:

```sh
brew install xcodegen   # once
xcodegen generate
open Plan.xcodeproj
```

**One manual prerequisite:** Xcode → Settings → Accounts → sign in with the
Apple ID on the paid developer team (B2F6TWN8SZ). Without it every device build
fails with "No Accounts / No profiles".

## Run on a phone

1. Cable the phone, tap Trust, enable Developer Mode (Settings → Privacy &
   Security; phone restarts).
2. Select the phone as destination, Run the PlanMessages scheme, choose
   Messages as the host app.
3. In any conversation: app drawer → Plan. Drawer-open loads the deployed
   worker; a tapped card loads that card's `url`.

## Gotchas (from the Linq iMessage Apps doc)

- Wrong team_id/bundle_id → card silently renders as plain text. No error.
- `fallback_text` containing dates/times/addresses/day-words also kills the
  card render — keep it static ("Open the plan").
- App cards are iMessage-only and must be the only part in the message.
- Every in-place card update returns a NEW message id; the old one is dead.
