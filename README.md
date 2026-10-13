# usage-band

Band above the prompt: ctx %, cache countdown (1h TTL) and hit rate, 5h/7d quota used with pace, colored by level (quota green <50%, yellow <80%, red after; cache green >20m, yellow ≤20m, red cold)

```bash
claude plugin marketplace add Hsiang-LinC/usage-band
claude plugin install usage@usage-band
```

Private repo: needs `gh auth login` (or any git credential for github.com) on the machine.

Test: `claude plugin test .`

## Pace

5h and 7d compare the share used with the share of the window that has passed
(from `resetsAt`) and show it as a sign (5h puts its reset time after it; 7d shows the sign only):

| sign | burn, against an even one |
|---|---|
| `▾` (green) | more than 5 points under the elapsed share |
| `⋅` (yellow) | within 5 points |
| `▴` (red) | more than 5 points over |

`5h 50% ▴ 2h10m` reads: half used, burning faster than even, 2h10m to reset.
The pace counts from the start of the window. The `♨` is red while the cache is hot,
light blue once it has gone cold, and plain before the first request.

## Pressing the band

Press (or click, where the terminal reports clicks) a figure that offers an action:

- `ctx 55%`: from 50% context (the yellow threshold, so yellow and red alike), while no request is running, the figure itself is the button. It runs
  `/compact`; a refused or vetoed compact is shown as a toast. The cache then
  starts over (`cache --`), since the prefix has changed.
- `cache 52m ♨ hit 90%`: the hot-spring sign is always there, in the place of the dot, so the band does not shift. Plain
  and inert while the cache has 30 minutes or more left; with less, it turns
  red and can be pressed. Pressed, it sends one tiny request over the session's own prefix (`$.model.fork`),
  which reads the cached prefix and restarts the 1h TTL; a toast says how many
  tokens the cache served. It stays plain while a request runs, for 30s
  after a failed press, before the first request and once the cache is cold
  (that request would write the whole prefix again). It is a real request: on a
  subscription it counts against the quota. The cache segment turns yellow with
  20 minutes left and red when cold.

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
