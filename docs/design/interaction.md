# Band interaction

Status: proposed · 2026-10-11

## Context

The band is read-only. Wanted: press a segment to act on it or change its view, and a compact/detailed mode for the whole band.

## Verified API (claude-code types, build 2.1.295)

| Need | API | Constraint |
| --- | --- | --- |
| Pressable segment | `Button` (`$.ui.resolve(e)`), `onPress`, `plain`, `hotkey` | Terminal draws it as text (`plain`) or `[ label ]`; desktop draws a native button, so layout must be re-checked there. |
| Compact | `$.session.compact()` | Same call as `/compact`; **rejects while a turn runs**; resolves `{ skip }` if a hook vetoed. |
| Keep-warm | `$.model.fork({ prompt })` | Re-sends the main thread's last request (same prefix) plus a short prompt, so the API serves the prefix from cache. Its own tail is never cached. **Prefix is billed afresh once the entry lapsed.** |
| Persist view state | `$.store.get/set` | JSON, per plugin, survives sessions and hot reload. |
| Settings UI | `userConfig` in `plugin.json` → rows in the config menu; `options` reach `register(on, options)` | A change reloads the module. |

Not found: no built-in keep-alive. `$.model.fork` is the closest primitive.

## Principles and convention

- Pure core / imperative shell: `format.ts` stays pure and decides *what* is shown and *which action* a segment offers; `register.tsx` owns state, store and side effects.
- Single source of truth, single writer: one view state (once detailed mode exists) in `register.tsx`, persisted in `$.store`; a future `/ub` command and the buttons both go through the same setter.
- Fail fast, bounded: actions never retry; every action is gated by state so it cannot be pressed into a costly or rejected call.
- Convention: `Button` + `onPress` is the platform's pressable; `userConfig` for static defaults, `$.store` for state the user toggles at runtime.

## Decisions

### 1. Actions are data on `Segment`

`Segment` gains optional fields that say what a segment offers: `detail` (text shown on press, built in this step) and later an action for compact and keep-warm. `formatSegments` sets them only when their precondition holds; `register.tsx` wraps such a segment in `Button plain`. No field, no button. (conforms: core stays pure and unit-testable with injected `now`.)

Layout consequences found while building:

- A `Button` is refused inside an inline `Text`, so the band is a `Box` row (`gap`, `flexWrap`) and separators carry no spaces (the desktop trims whitespace at flex-item edges).
- A Button's colour cannot be set: a surface that draws no children draws the `label` in its own style (the terminal does), so colour on the Button's `Text` children is lost. Segments therefore stay coloured plain text and an action is a separate plain Button beside it (`ctx 45% → compact`, `cache 52m → warm`); the detail of hit / 5h / 7d is one `info` Button at the end rather than a Button per segment.

### 2. Compact button

- Shown when `ctx ≥ 30%` (`COMPACT_BUTTON_FROM`, constant in `format.ts`) **and no request is in flight** (`pending` empty), because `compact()` rejects mid-turn.
- Replaces the text hint at ≥80% (`→ /compact or hand off` becomes the button label plus the hand-off wording).
- Compacting changes the prefix, so the cached one no longer matches: the band drops back to `cache --` until the next request starts a new countdown. Label says `compact`, not "free space".
- Rejection or `{ skip }` → `$.ui.toast` with the reason; no retry.

### 3. Keep-warm button

- Shown whenever the cache is **warm** and the session idle (first drawn only in the last 10 minutes; always-on was preferred after trying it). The cache segment's colour is what warns as the end nears. When cold, `fork` would re-bill the whole prefix as a write, which is the opposite of the intent; no button.
- Press → `$.model.fork({ prompt: <minimal> })`; discard the reply. Guard: ignore while one is in flight and within 30 s of the last press (bounded; prevents double-press spend).
- On success set `warmedAt = now`. The countdown runs from `max(newest pending/answered send, warmedAt)`. A fork does not produce a main-thread `turn.step`, so without this the band would not reset.
- Failure (`api-error`, `nothing-to-fork`, `aborted`) → toast the reason, leave the countdown untouched.
- Not verified: whether a fork leaves a session or transcript file behind (the API says it is a completion over the session's transcript, nothing more), and what it costs in subscription quota. The throwaway probe in the TTL experiment logs both.
- Open question (inference, unverified): that a fork's cache read restarts the 1h TTL on the server. Verify empirically before shipping: press at ~55 m, confirm the next real request still reads from cache at ~65 m.
- Cost: one cache read of the prefix plus a few output tokens. Press-to-extend is only worth it when the user will return within the hour; do not auto-fire (non-goal).

### 4. Quota pace and press-for-detail (replaces the first idea of view toggles)

A used-% / time-to-reset toggle added nothing: 5h already shows both. What the API does not give is *whether the burn will last*. From the window length (5h, 7d), `resetsAt` and the used share:

- `pace = used share / elapsed share` of the window; 1 is an even burn. Marker `▴` when > 1.25, `▾` when < 0.75, none between.
- `fullIn = (1 − used) / (used / elapsed)`; shown as `→ full 1h00m` only when it comes **before the reset**. It lifts an `ok` level to `warn`.
- Nothing is shown until 10% of the window has passed (`MIN_ELAPSED`): earlier, the rate is noise.
- Pressing `info` toasts the detail of every segment that has one: `5h` / `7d` (used, time to reset, pace, full-in) and `hit` (newest request's read / written / uncached tokens and the session-wide hit rate). No persisted view state: a press changes nothing on the band.

### 5. Compact vs detailed mode

- `mode: 'compact' | 'detailed'`, default `compact` (today's band, unchanged).
- Detailed adds a second line; the first line is identical in both modes so toggling never moves the existing segments.
- Detailed content: absolute ctx tokens (`62k/200k`), cache expiry clock time, 5h/7d reset clock time, session cost, model name.
- Non-goals: sub-agent count (sub-agents are deliberately ignored by the cache logic; showing them adds a second source of truth).
- Toggle control (needs `$.store`, see 6): the star icon (it already sits at a fixed 2-cell width). Pressing it cycles the mode.

### 6. State and persistence

Slice 2 needs none: presses are toasts. Persistence (`$.store`, a single `setView` writer) returns with detailed mode (`mode`), where a choice must survive a session.

## Options considered for how actions are triggered

| Option | Verdict |
| --- | --- |
| A. `Button` + `onPress` on segments (this doc) | conforms; recommended |
| B. Hotkeys only (`hotkey` prop) | extends; available as a free addition on the same Buttons, but hotkeys fire only when the band holds focus |
| C. `/ub` slash commands only | extends; planned separately (inbox note `/ub`), reuses `setView` |

## Rollout (walking skeleton, then slices)

1. Plumbing: `Segment.detail`, `Button` wrapper, flex-row band (done). Verify on **terminal and desktop**: desktop trims whitespace at flex-item edges, so spacing comes from `gap`.
2. Pace / full-in on 5h and 7d, and press-for-detail on quota and hit (done).
3. Compact button (done).
4. Detailed mode (second line) and the layout pass.
5. Keep-warm button (done, ahead of the TTL verification; see the open question in 3).

Each slice ships as its own commit with a version bump in a separate `chore: bump version` commit; update README and `marketplace.json` description when the band's contents change.

## Risks

- Desktop draws native buttons: width and alignment may differ from the terminal; the fixed 2-cell star box and inline-run separators were added for this and must keep working.
- Desktop runs the plugin cache, not the working tree: confirm the loaded code before debugging visuals.
- A second line changes the band's height; check it does not collide with the survey (`hasSurvey` already skips the band).
