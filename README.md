# usage-band

A compact, low-distraction band above the Claude Code prompt: how much of your 5-hour and weekly limits is left, a live countdown to the reset, and a pace forecast. Click the arrow to expand.

```
5h ▰▰▰▰▰▱▱▱ 63% ⟳ 2h 14m   7d ▰▰▰▱▱▱▱▱ 41% ↯ ⟳ 3d 4h   ctx ▰▰▰▱ 27%   $1.37   ▸
```

Expanded:

```
5h    ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰┃▱▱▱▱▱▱▱▱ 63% left (37% used)
      resets in 2:14:07 (18:40)  ·  pace is fine
7d    ▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱┃▱▱▱▱▱▱▱▱ 41% left (59% used)
      resets in 3d 4h (Sat 09:00)  ·  at this pace runs out in 1d 6h
      ┃ = where an even pace would be right now
ctx   ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱ 82k / 200k tokens (41% full)
session 1h 22m · 14 turns · $1.37 · $1.00/h
```

- Bars show the share **remaining**: green above 40%, yellow to 15%, red below.
- `⟳` is the countdown to the window's reset; in the final hour of the 5h window it ticks every second.
- `↯` appears when, at your current burn rate, a limit would run out before it resets (the expanded view says when).
- `┃` marks where an even pace over the window would put you right now: if the filled part ends left of it, you are spending faster than the clock.
- Context fill, session length, turns, cost and cost per hour round it out. Without a subscription only context and cost are shown.

Claude Code does not expose a total token count per session or week, so context tokens and cost stand in for it.

## Install

```
/plugin marketplace add 1s0meb0dy1/Claude-Info
/plugin install usage-band@usage-band
```
