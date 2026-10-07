# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`usage-band` is a Claude Code plugin (marketplace `usage-band`, plugin `usage`) that renders a one-line band above the prompt: ctx %, prompt-cache countdown (1h TTL) + hit rate, 5h/7d quota used, plus a star icon that animates while a main-thread request runs. No build step, no package.json, no dependencies: TypeScript is loaded directly by Claude Code as a hooks module.

## Commands

- Test: `claude plugin test .` (tests import from `claude-code/testing`, not a standard runner)
- Install from the marketplace: `claude plugin marketplace add Hsiang-LinC/usage-band && claude plugin install usage@usage-band`
- Type checking relies on `tsconfig.json` extending `.claude-plugin/types/tsconfig.json`, which is gitignored and provided by the Claude Code plugin tooling; it won't exist in a fresh checkout.

## Architecture

- `hooks/hooks.json` registers `./register.tsx` as the module.
- `hooks/format.ts` is the pure core: `formatSegments(LineInput) → Segment[]` (text, `Level` ok/warn/bad/none, group session|quota) and `formatLine`. All thresholds live here (usage green <50, yellow <80, red ≥80; cache green >5m, yellow ≤5m, red cold; ctx ≥80% appends a `/compact` hint). `now` is injected, so it is unit-tested in `format.test.ts`.
- `hooks/register.tsx` is the imperative shell: module-level state fed by engine events, rendered by the `ui.render` handler on the `AbovePrompt` component (skipped when `hasSurvey`).
  - `session.start` / `session.measure` update ctx and rate limits; a 5s poll covers idle sessions.
  - `turn.step` (per request, not per turn) records `lastTurn` for the cache figures. `cachedAt` is the time the request was *sent*, because that is when the TTL restarts. Only main-thread steps (`agentId === undefined`) count; sub-agents are ignored. A 60s ticker phased on each request redraws the countdown; a `busy` counter drives the 200ms star animation only while requests are in flight.
  - `$.clock.every`/`after` return a `Timer`; stop it with `.cancel()`, never by calling it.
- Light/dark palettes, neutral separators, value-only bold styling and the ochre/blue-grey/vermilion star cycle live in `register.tsx`. Built-in themes follow `$.config.list()`; auto/custom themes read macOS appearance with a 1s process timeout and a 5s cached promise. Level decisions remain in `format.ts`.

## Conventions

- Version is in `.claude-plugin/plugin.json` and bumped in separate `chore: bump version` commits. `marketplace.json` holds a duplicate plugin description, so keep it in sync with `plugin.json` and README when the band's contents change.
- Conventional Commits.
