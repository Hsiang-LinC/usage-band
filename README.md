# usage-band

Band above the prompt: ctx %, cache countdown (1h TTL) and hit rate, 5h/7d quota used with pace, colored by level (quota green <50%, yellow <80%, red after; cache green >5m, yellow ≤5m, red cold; ctx same, and from 80% suggests /compact or a handoff)

```bash
claude plugin marketplace add Hsiang-LinC/usage-band
claude plugin install usage@usage-band
```

Private repo: needs `gh auth login` (or any git credential for github.com) on the machine.

Test: `claude plugin test .`

## Pace

5h and 7d compare the share used with the share of the window that has passed
(from `resetsAt`): `▴` is a faster burn than an even one, `▾` a slower one. When
the burn so far would hit 100% before the reset, `→ full 1h00m` says when, and
a low share turns yellow. Nothing shows until a tenth of the window has passed.

## Pressing the band

- `ctx`: from 30% context, while no request is running, it reads `→ compact`
  and runs `/compact`. A refused or vetoed compact is shown as a toast. The
  cache then starts over (`cache --`), since the prefix has changed.
- `5h`, `7d`: a toast with the share used, time to reset, pace and time to full.
- `hit`: a toast with the newest request's read / written / uncached tokens and
  the hit rate across the session.

Click where the terminal reports clicks (not with `CLAUDE_CODE_DISABLE_MOUSE_CLICKS`),
or press `ctrl+x` then `Tab` to focus the band, move with the arrows and press Enter.

## Appearance

The band uses a Wada-inspired green / ochre / vermilion palette, with light/dark
text colours and no background fill, so the terminal background shows through. Labels keep the terminal's normal monospace font;
percentages and countdowns are bold. Separators use a neutral colour.
The working star cycles ochre → blue-grey → vermilion: a shape changes every
200ms, and each colour holds for 1.2s, without opacity blinking.

Built-in light/dark variants follow Claude Code's selected theme. For `auto`
and custom themes, this version follows macOS system appearance, checked at
most once every 5 seconds; it does not infer a custom theme's background.
Automatic appearance detection currently requires macOS. Use an explicit
built-in light/dark theme on other hosts.
