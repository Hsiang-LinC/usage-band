# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`usage-band` is a Claude Code plugin (marketplace `usage-band`, plugin `usage`) that renders a one-line band above the prompt: ctx %, prompt-cache countdown (1h TTL) + hit rate, 5h/7d quota used, plus a star icon that animates while a main-thread request runs. No build step, no package.json, no dependencies: TypeScript is loaded directly by Claude Code as a hooks module.

## Commands

- Test: `claude plugin test .` (tests import from `claude-code/testing`, not a standard runner)
- Reinstall the working copy: `./scripts/reinstall.sh`. Run it after a change and before trying it out: the desktop app and the CLI pick up an installed plugin on their own schedules and drift apart otherwise. Open sessions keep the old code until restarted.
- Install from the marketplace: `claude plugin marketplace add Hsiang-LinC/usage-band && claude plugin install usage@usage-band`
- Type checking relies on `tsconfig.json` extending `.claude-plugin/types/tsconfig.json`, which is gitignored and provided by the Claude Code plugin tooling; it won't exist in a fresh checkout.

## Architecture

- `hooks/hooks.json` registers `./register.tsx` as the module.
- `hooks/format.ts` is the pure core: `formatSegments(LineInput) → Segment[]` (text, `Level` ok/warn/bad/none, group session|quota, optional `action`: compact or keep-warm) and `formatLine`. All thresholds live here (usage green <50, yellow <80, red ≥80; cache green >20m, yellow ≤20m, red cold; ctx uses the usage levels; 5h shows a pace sign ▾ ~ ▴ and the time to reset, 7d the sign only). `now` is injected, so it is unit-tested in `format.test.ts`.
- `hooks/register.tsx` is the imperative shell: module-level state fed by engine events, rendered by the `ui.render` handler on the `AbovePrompt` component (skipped when `hasSurvey`).
  - `session.start` / `session.measure` update ctx and rate limits; a 5s poll covers idle sessions and redraws only when a figure or the minute changed.
  - `turn.step` (per request, not per turn) drives the cache figures. The countdown restarts when a request is *sent*, because that is when the TTL restarts: in-flight requests sit in `pending`, and the countdown runs from the newest send among `pending` and `answered` (the newest request whose response reported usage, which also supplies the hit rate). A request that ends without usage (failed, interrupted) confirms nothing and drops out, rolling the countdown back. Only main-thread steps (`agentId === undefined`) count; sub-agents are ignored. A 60s ticker phased on the countdown's start redraws it; a non-empty `pending` drives the 200ms star animation.
  - The band is a `Box` row of flex items, spaced by `gap` (the desktop trims whitespace at item edges, so separators carry no spaces). A `Button` is drawn in the surface's own style and ignores colour on its children, so the ctx segment is itself a Button wrapping its coloured `Text` (pressable from 50%, i.e. yellow and red, while idle; `$.session.compact()`; the terminal may draw it uncoloured) and the always-drawn `♨` keep-warm sign, which stands in place of the dot after the cache segment (the same glyph always: plain and inert, red and pressable with under 30 minutes of cache left and an idle session; `$.model.fork()`, a real request, 30s cooldown). Design notes are in `docs/design/interaction.md`.
  - `$.clock.every`/`after` return a `Timer`; stop it with `.cancel()`, never by calling it.
- Light/dark palettes, neutral separators, value-only bold styling and the ochre/blue-grey/vermilion star cycle live in `register.tsx`. Built-in themes follow `$.config.list()`; auto/custom themes read macOS appearance with a 1s process timeout and a 5s cached promise. Level decisions remain in `format.ts`.

## Conventions

- Version is in `.claude-plugin/plugin.json` and bumped in separate `chore: bump version` commits. `marketplace.json` holds a duplicate plugin description, so keep it in sync with `plugin.json` and README when the band's contents change.
- Conventional Commits.
