import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Meta, Snapshot } from '../types'

const snapshot = atom({ plugin: 'usage-band', key: 'snapshot' } as const, null)
const isOpen = atom({ plugin: 'usage-band', key: 'isOpen' } as const, false)
const clockNow = atom({ plugin: 'usage-band', key: 'now' } as const, 0)
const isCompact = atom({ plugin: 'usage-band', key: 'isCompact' } as const, false)
const meta = atom(
  { plugin: 'usage-band', key: 'meta' } as const,
  { startedAt: 0, turns: 0, lastUsd: null, last: null, notified: [] },
)

const ALERTS = [80, 95]
/** State saved by an older version lacks newer fields; fill them in. */
const fresh = (m: Partial<Meta> | null | undefined): Meta => ({
  startedAt: m?.startedAt ?? 0,
  turns: m?.turns ?? 0,
  lastUsd: m?.lastUsd ?? null,
  last: m?.last ?? null,
  notified: m?.notified ?? [],
})

const MIN = 60_000
const HOUR = 60 * MIN
const WINDOW_MS: Record<string, number> = {
  five_hour: 5 * HOUR,
  seven_day: 7 * 24 * HOUR,
}
const label: Record<string, string> = {
  five_hour: '5h',
  seven_day: '7d',
  spend_limit: 'spend',
}

const fmt = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${Math.round(n / 1000)}k`
      : `${n}`

/** Thin line gauge: a heavy line for what is left, a dotted track for the rest. */
const gauge = (remaining: number, width: number) => {
  const filled = Math.round((Math.max(0, Math.min(100, remaining)) / 100) * width)
  return { on: '━'.repeat(filled), off: '╌'.repeat(width - filled) }
}

const tone = (remaining: number) =>
  remaining > 40 ? 'success' : remaining > 15 ? 'warning' : 'error'

const two = (n: number) => String(n).padStart(2, '0')

/** Countdown: h:mm:ss when `precise`, else "2h 14m"; "3d 4h" for far windows. */
const countdown = (ms: number, precise: boolean) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (precise) return `${h}:${two(m)}:${two(s % 60)}`
  return h > 0 ? `${h}h ${two(m)}m` : `${m}m`
}

const span = (ms: number) => {
  const m = Math.max(0, Math.round(ms / MIN))
  return m >= 60 ? `${Math.floor(m / 60)}h ${two(m % 60)}m` : `${m}m`
}

const clockTime = (iso: string) => {
  const d = new Date(iso)
  return `${two(d.getHours())}:${two(d.getMinutes())}`
}

type Row = {
  kind: string
  used: number
  remaining: number
  msLeft: number | null
  /** Share of the window's time still ahead, 0..100. */
  timeLeftPct: number | null
  /** ms until the limit runs out at the current pace, if before the reset. */
  runsOutIn: number | null
  resetsAt?: string
}

const rowFor = (r: Snapshot['rateLimits'][number], now: number): Row => {
  const total = WINDOW_MS[r.kind]
  const msLeft = r.resetsAt ? Math.max(0, Date.parse(r.resetsAt) - now) : null
  const elapsed = total !== undefined && msLeft !== null ? total - msLeft : null
  const timeLeftPct =
    total !== undefined && msLeft !== null ? (msLeft / total) * 100 : null
  let runsOutIn: number | null = null
  if (elapsed !== null && msLeft !== null && elapsed > 10 * MIN && r.percentUsed > 0) {
    const toLimit = ((100 - r.percentUsed) / r.percentUsed) * elapsed
    if (toLimit < msLeft) runsOutIn = toLimit
  }
  return {
    kind: r.kind,
    used: r.percentUsed,
    remaining: Math.max(0, 100 - r.percentUsed),
    msLeft,
    timeLeftPct,
    runsOutIn,
    resetsAt: r.resetsAt,
  }
}


// ── Vector drawing (desktop, VS Code, mobile): Svg replaces the text gauges ──

const COLORS = {
  success: '#22c55e',
  warning: '#f59e0b',
  error: '#ef4444',
  accent: '#8b5cf6',
}

const colorFor = (remaining: number) =>
  remaining > 40 ? COLORS.success : remaining > 15 ? COLORS.warning : COLORS.error

const esc = (t: string) =>
  t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Neutral greys and alpha fills read on a light and a dark page alike. */
const SVG_STYLE = `<style>
  text{font-family:-apple-system,"Segoe UI",system-ui,Roboto,sans-serif}
  .t{fill:#1f2328}.m{fill:#6b7280}
  @media (prefers-color-scheme:dark){.t{fill:#e6edf3}.m{fill:#9ca3af}}
  .tr{fill:none;stroke:rgba(128,128,128,.28)}
  .pill{fill:rgba(128,128,128,.10);stroke:rgba(128,128,128,.22)}
</style>`

const ring = (cx: number, cy: number, r: number, pct: number, color: string) => {
  const c = 2 * Math.PI * r
  const arc = (Math.max(0, Math.min(100, pct)) / 100) * c
  return (
    `<circle class="tr" cx="${cx}" cy="${cy}" r="${r}" stroke-width="4"/>` +
    (arc > 0
      ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="4" ` +
        `stroke-linecap="round" stroke-dasharray="${arc.toFixed(1)} ${c.toFixed(1)}" ` +
        `transform="rotate(-90 ${cx} ${cy})"/>`
      : '')
  )
}

type Chip = {
  title: string
  value: string
  pct: number | null
  color: string
  isCritical?: boolean
  warn?: boolean
  width: number
}

const chipSvg = (x: number, c: Chip) =>
  `<g transform="translate(${x} 0)">` +
  `<rect class="pill" x="0.5" y="4.5" width="${c.width - 1}" height="35" rx="17.5"` +
  (c.isCritical ? ` style="fill:rgba(239,68,68,.14);stroke:${COLORS.error}"` : '') +
  `/>` +
  (c.pct !== null ? ring(22, 22, 11, c.pct, c.color) : '') +
  `<text class="m" x="${c.pct !== null ? 42 : 18}" y="19" font-size="10" letter-spacing=".6">${esc(c.title)}</text>` +
  `<text class="t" x="${c.pct !== null ? 42 : 18}" y="33" font-size="12.5" font-weight="600">${esc(c.value)}` +
  (c.warn ? `<tspan fill="${COLORS.warning}"> ↯</tspan>` : '') +
  `</text></g>`

type GraphicInput = {
  rows: Row[]
  ctxPct: number | null
  tokens: number | null
  window: number
  usd: number | null
  sessionMs: number
  meta: Meta
}

const summarySvg = (g: GraphicInput) => {
  const chips: Chip[] = g.rows.map(r => {
    const fiveH = r.kind === 'five_hour'
    const long = r.kind === 'seven_day'
    return {
      title: fiveH ? '5-HOUR' : long ? 'WEEKLY' : (label[r.kind] ?? r.kind).toUpperCase(),
      value:
        `${r.remaining.toFixed(0)}% left` +
        (r.msLeft !== null ? ` · ${countdown(r.msLeft, fiveH && r.msLeft < HOUR)}` : ''),
      pct: r.remaining,
      color: colorFor(r.remaining),
      isCritical: r.remaining <= 15,
      warn: r.runsOutIn !== null,
      width: 178,
    }
  })
  if (g.ctxPct !== null) {
    chips.push({
      title: 'CONTEXT',
      value: `${g.ctxPct.toFixed(0)}% · ${fmt(g.tokens ?? 0)}`,
      pct: g.ctxPct,
      color: COLORS.accent,
      width: 128,
    })
  }
  if (g.usd !== null) {
    chips.push({
      title: 'SESSION',
      value: `$${g.usd.toFixed(2)}`,
      pct: null,
      color: COLORS.accent,
      width: 84,
    })
  }
  let x = 0
  const parts = chips.map(c => {
    const out = chipSvg(x, c)
    x += c.width + 8
    return out
  })
  const width = Math.max(40, x - 8)
  return {
    width,
    height: 44,
    svg:
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} 44" width="${width}" height="44">` +
      SVG_STYLE +
      parts.join('') +
      `</svg>`,
  }
}

const bar = (
  x: number,
  y: number,
  w: number,
  remaining: number,
  color: string,
  marker: number | null,
) => {
  const fill = Math.max(0, Math.min(100, remaining)) / 100
  const fw = fill > 0 ? Math.max(8, w * fill) : 0
  return (
    `<rect x="${x}" y="${y}" width="${w}" height="8" rx="4" fill="rgba(128,128,128,.22)"/>` +
    (fw > 0 ? `<rect x="${x}" y="${y}" width="${fw.toFixed(1)}" height="8" rx="4" fill="${color}"/>` : '') +
    (marker !== null
      ? `<rect class="t" x="${(x + (w * marker) / 100 - 1).toFixed(1)}" y="${y - 3}" width="2" height="14" rx="1" opacity=".75"/>`
      : '')
  )
}

const cardSvg = (g: GraphicInput) => {
  const W = 560
  const pad = 16
  const inner = W - pad * 2
  let y = 20
  const out: string[] = []

  const block = (
    title: string,
    sub: string,
    right: string,
    remaining: number,
    color: string,
    marker: number | null,
    detail: string,
    isCritical: boolean,
  ) => {
    out.push(
      `<text class="t" x="${pad}" y="${y}" font-size="13" font-weight="700">${esc(title)}` +
        `<tspan class="m" font-weight="400" font-size="11.5">  ${esc(sub)}</tspan></text>` +
        `<text x="${W - pad}" y="${y}" text-anchor="end" font-size="13" font-weight="700" ` +
        `fill="${isCritical ? COLORS.error : color}">${esc(right)}</text>` +
        bar(pad, y + 9, inner, remaining, color, marker) +
        `<text class="m" x="${pad}" y="${y + 36}" font-size="11.5">${esc(detail)}</text>`,
    )
    y += 56
  }

  for (const r of g.rows) {
    const fiveH = r.kind === 'five_hour'
    const reset =
      r.msLeft !== null
        ? `resets in ${countdown(r.msLeft, true)}${r.resetsAt ? ` · ${clockTime(r.resetsAt)}` : ''}`
        : 'no reset time'
    const pace =
      r.runsOutIn !== null
        ? `  ·  ↯ runs out in ${span(r.runsOutIn)} at this pace`
        : r.timeLeftPct !== null
          ? '  ·  comfortable pace'
          : ''
    block(
      label[r.kind] ?? r.kind,
      fiveH ? '5-hour window' : r.kind === 'seven_day' ? 'weekly window' : '',
      `${r.remaining.toFixed(0)}% left`,
      r.remaining,
      colorFor(r.remaining),
      r.timeLeftPct,
      reset + pace,
      r.remaining <= 15,
    )
  }
  if (g.ctxPct !== null && g.tokens !== null) {
    block(
      'Context',
      'current window',
      `${g.ctxPct.toFixed(0)}% full`,
      g.ctxPct,
      COLORS.accent,
      null,
      `${fmt(g.tokens)} of ${fmt(g.window)} tokens`,
      false,
    )
  }

  if (g.rows.some(r => r.timeLeftPct !== null)) {
    out.push(
      `<rect class="t" x="${pad}" y="${y - 10}" width="2" height="12" rx="1" opacity=".75"/>` +
        `<text class="m" x="${pad + 10}" y="${y}" font-size="10.5">where an even pace would be right now</text>`,
    )
    y += 22
  }

  const stats: string[] = []
  stats.push(
    `session ${span(g.sessionMs)} · ${g.meta.turns} turns` +
      (g.usd !== null
        ? ` · $${g.usd.toFixed(2)}` +
          (g.sessionMs > 10 * MIN ? ` · $${((g.usd / g.sessionMs) * HOUR).toFixed(2)}/h` : '')
        : ''),
  )
  if (g.meta.last) {
    const l = g.meta.last
    stats.push(
      `last turn ${l.seconds}s · ${fmt(l.output)} out` +
        (l.cachePct !== null ? ` · cache ${l.cachePct.toFixed(0)}%` : '') +
        (l.usd !== null ? ` · $${l.usd.toFixed(2)}` : ''),
    )
  }
  out.push(
    `<line x1="${pad}" y1="${y - 14}" x2="${W - pad}" y2="${y - 14}" stroke="rgba(128,128,128,.25)"/>`,
  )
  for (const line of stats) {
    out.push(`<text class="m" x="${pad}" y="${y + 4}" font-size="11.5">${esc(line)}</text>`)
    y += 18
  }
  const H = y + 6
  return {
    width: W,
    height: H,
    svg:
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">` +
      SVG_STYLE +
      `<rect class="pill" x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="14"/>` +
      out.join('') +
      `</svg>`,
  }
}

const take = (u: {
  rateLimits: Snapshot['rateLimits']
  context: { tokens?: number; window: number }
  cost?: { usd: number }
}): Snapshot => ({
  rateLimits: u.rateLimits.map(r => ({
    kind: r.kind,
    percentUsed: r.percentUsed,
    resetsAt: r.resetsAt,
  })),
  tokens: u.context.tokens ?? null,
  window: u.context.window,
  usd: u.cost?.usd ?? null,
})

export const register: Register = on => {
  let timer: { cancel: () => void } | null = null

  on('session.start', async ($, e, next) => {
    const first = take(await $.session.usage())
    const t = await $.clock.now()
    await update($, snapshot, () => first)
    await update($, clockNow, () => t)
    await update($, meta, raw => {
      const m = fresh(raw)
      return { ...m, startedAt: m.startedAt || t }
    })

    timer?.cancel()
    // Redraws only when the shown text can change: every second in the final
    // hour of the 5h window, otherwise every 15 s.
    timer = $.clock.every(1000, async () => {
      const t0 = await $.clock.now()
      const snap = await read($, snapshot)
      const five = snap?.rateLimits.find(r => r.kind === 'five_hour')
      const left = five?.resetsAt ? Date.parse(five.resetsAt) - t0 : Infinity
      const prev = await read($, clockNow)
      const step = left < HOUR ? 1000 : 15_000
      if (t0 - prev >= step) await update($, clockNow, () => t0)
    })

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const snap = take(e)
    await update($, snapshot, () => snap)

    const m = fresh(await read($, meta))
    const announced: string[] = []
    for (const r of snap.rateLimits) {
      for (const threshold of ALERTS) {
        const key = `${r.kind}:${r.resetsAt ?? ''}:${threshold}`
        if (r.percentUsed >= threshold && !m.notified.includes(key)) {
          announced.push(key)
          const left = Math.max(0, 100 - r.percentUsed).toFixed(0)
          $.ui.toast(`${label[r.kind] ?? r.kind} limit: ${left}% left`)
        }
      }
    }
    const usd = snap.usd
    const spent = usd !== null && m.lastUsd !== null ? usd - m.lastUsd : null
    await update($, meta, raw => {
      const cur = fresh(raw)
      return {
      ...cur,
      lastUsd: usd ?? cur.lastUsd,
      last:
        cur.last && spent !== null && spent > 0
          ? { ...cur.last, usd: spent }
          : cur.last,
      // Keep only keys that can still matter: the newest few.
      notified: [...cur.notified, ...announced].slice(-24),
      }
    })
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const u = e.usage
    const inputSide = u ? u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens : 0
    await update($, meta, raw => {
      const m = fresh(raw)
      return {
      ...m,
      turns: m.turns + 1,
      last: {
        seconds: Math.round(e.durationMs / 1000),
        output: u?.output_tokens ?? 0,
        cachePct: u && inputSide > 0 ? (u.cache_read_input_tokens / inputSide) * 100 : null,
        usd: null,
      },
      }
    })
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    // Installed mid-session: session.start has passed, so load the figures now.
    const s = (await read($, snapshot)) ?? take(await $.session.usage())

    const open = await read($, isOpen)
    const stamp = await read($, clockNow)
    const m = fresh(await read($, meta))
    const compact = await read($, isCompact)
    const now = stamp || (await $.clock.now())
    const { Box, Text, Button } = $.ui.resolve(e)

    const rows = s.rateLimits.map(r => rowFor(r, now))
    const ctxPct = s.tokens === null ? null : Math.min(100, (s.tokens / s.window) * 100)
    const sessionMs = m.startedAt ? now - m.startedAt : 0
    const worst = rows.reduce<Row | null>(
      (a, r) => (a === null || r.remaining < a.remaining ? r : a),
      null,
    )
    const dot = <Text dimColor> │ </Text>

    if (compact) {
      const five = rows.find(r => r.kind === 'five_hour') ?? worst
      return (
        <Box>
          <Text color={worst ? tone(worst.remaining) : 'inactive'}>● </Text>
          {rows.map(row => (
            <Text key={row.kind} dimColor tabular>
              {label[row.kind] ?? row.kind} {row.remaining.toFixed(0)}%{'  '}
            </Text>
          ))}
          {five?.msLeft != null ? (
            <Text dimColor tabular>
              ⟳ {countdown(five.msLeft, five.kind === 'five_hour' && five.msLeft < HOUR)}{'  '}
            </Text>
          ) : null}
          <Button key="expand" dimColor label="▸" onPress={() => update($, isCompact, () => false)} />
        </Box>
      )
    }

    if (e.surface !== 'terminal') {
      const { Svg } = $.ui.resolve(e)
      const g: GraphicInput = {
        rows,
        ctxPct,
        tokens: s.tokens,
        window: s.window,
        usd: s.usd,
        sessionMs,
        meta: m,
      }
      const head = summarySvg(g)
      const nothing = rows.length === 0 && ctxPct === null && s.usd === null
      return (
        <Box flexDirection="column">
          <Box alignItems="center">
            {nothing ? (
              <Text dimColor>usage: no data yet  </Text>
            ) : (
              <Svg
                key="summary"
                source={head.svg}
                alt={rows
                  .map(r => `${label[r.kind] ?? r.kind} ${r.remaining.toFixed(0)}% left`)
                  .join(', ')}
                width={head.width}
                height={head.height}
              />
            )}
            <Button
              key="toggle"
              dimColor
              label={open ? '▾' : '▸'}
              onPress={() => update($, isOpen, v => !v)}
            />
          </Box>
          {open ? (
            <Box flexDirection="column">
              <Svg
                key="card"
                source={cardSvg(g).svg}
                alt="Usage details: limits, context, session"
                width={cardSvg(g).width}
                height={cardSvg(g).height}
              />
              <Button
                key="compact"
                dimColor
                label="compact view"
                onPress={() =>
                  update($, isCompact, () => true).then(() => update($, isOpen, () => false))
                }
              />
            </Box>
          ) : null}
        </Box>
      )
    }

    const chip = (row: Row, width: number) => {
      const g = gauge(row.remaining, width)
      const critical = row.remaining <= 15
      return (
        <Text key={row.kind}>
          {critical ? (
            <Text inverse color="error" bold>{` ${label[row.kind] ?? row.kind} `}</Text>
          ) : (
            <Text dimColor>{label[row.kind] ?? row.kind} </Text>
          )}
          <Text color={tone(row.remaining)}>{g.on}</Text>
          <Text dimColor>{g.off}</Text>
          <Text bold tabular> {row.remaining.toFixed(0)}%</Text>
          {row.runsOutIn !== null ? <Text color="warning"> ↯</Text> : null}
          {row.msLeft !== null ? (
            <Text dimColor tabular>
              {'  '}⟳ {countdown(row.msLeft, row.kind === 'five_hour' && row.msLeft < HOUR)}
            </Text>
          ) : null}
        </Text>
      )
    }

    const summary = (
      <Box>
        {rows.map((row, i) => (
          <Box key={row.kind}>
            {i > 0 ? dot : null}
            {chip(row, 8)}
          </Box>
        ))}
        {ctxPct !== null ? (
          <Text>
            {rows.length > 0 ? dot : null}
            <Text dimColor>ctx </Text>
            <Text color="suggestion" tabular>{ctxPct.toFixed(0)}%</Text>
          </Text>
        ) : null}
        {s.usd !== null ? (
          <Text>
            {rows.length > 0 || ctxPct !== null ? dot : null}
            <Text dimColor tabular>${s.usd.toFixed(2)}</Text>
          </Text>
        ) : null}
        {rows.length === 0 && s.tokens === null ? (
          <Text dimColor>usage: no data yet</Text>
        ) : null}
        <Text>{'  '}</Text>
        <Button
          key="toggle"
          dimColor
          label={open ? '▾' : '▸'}
          onPress={() => update($, isOpen, v => !v)}
        />
      </Box>
    )

    if (!open) return summary

    return (
      <Box flexDirection="column">
        {summary}
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="inactive"
          paddingX={1}
          marginTop={0}
        >
          {rows.map(row => {
            const g = gauge(row.remaining, 28)
            const tick = row.timeLeftPct === null ? null : Math.round((row.timeLeftPct / 100) * 28)
            return (
              <Box key={row.kind} flexDirection="column" marginBottom={1}>
                <Text>
                  <Text bold>{label[row.kind] ?? row.kind}</Text>
                  <Text dimColor>
                    {row.kind === 'five_hour'
                      ? '  5-hour window'
                      : row.kind === 'seven_day'
                        ? '  weekly window'
                        : ''}
                  </Text>
                </Text>
                <Text>
                  <Text color={tone(row.remaining)}>{g.on}</Text>
                  <Text dimColor>{g.off}</Text>
                  <Text bold tabular> {row.remaining.toFixed(0)}% left</Text>
                  <Text dimColor tabular>  ({row.used}% used)</Text>
                </Text>
                {tick !== null ? (
                  <Text dimColor>
                    {' '.repeat(Math.max(0, Math.min(27, tick - 1)))}▲ even pace
                  </Text>
                ) : null}
                <Text dimColor tabular>
                  {row.msLeft !== null
                    ? `resets in ${countdown(row.msLeft, true)}${row.resetsAt ? ` · ${clockTime(row.resetsAt)}` : ''}`
                    : 'no reset time'}
                  {row.runsOutIn !== null
                    ? `  ·  ↯ runs out in ${span(row.runsOutIn)} at this pace`
                    : row.timeLeftPct !== null
                      ? '  ·  on a comfortable pace'
                      : ''}
                </Text>
              </Box>
            )
          })}
          {ctxPct !== null && s.tokens !== null ? (
            <Box flexDirection="column" marginBottom={1}>
              <Text bold>Context</Text>
              <Text>
                <Text color="suggestion">{gauge(100 - ctxPct, 28).on}</Text>
                <Text dimColor>{gauge(100 - ctxPct, 28).off}</Text>
                <Text bold tabular> {ctxPct.toFixed(0)}% full</Text>
                <Text dimColor tabular>  {fmt(s.tokens)} / {fmt(s.window)} tokens</Text>
              </Text>
            </Box>
          ) : null}
          <Text dimColor tabular>
            session {span(sessionMs)} · {m.turns} turns
            {s.usd !== null ? ` · $${s.usd.toFixed(2)}` : ''}
            {s.usd !== null && sessionMs > 10 * MIN
              ? ` · $${((s.usd / sessionMs) * HOUR).toFixed(2)}/h`
              : ''}
          </Text>
          {m.last ? (
            <Text dimColor tabular>
              last turn {m.last.seconds}s · {fmt(m.last.output)} out
              {m.last.cachePct !== null ? ` · cache ${m.last.cachePct.toFixed(0)}%` : ''}
              {m.last.usd !== null ? ` · $${m.last.usd.toFixed(2)}` : ''}
            </Text>
          ) : null}
          <Box marginTop={1}>
            <Button
              key="compact"
              dimColor
              label="compact view"
              onPress={() =>
                update($, isCompact, () => true).then(() => update($, isOpen, () => false))
              }
            />
          </Box>
        </Box>
      </Box>
    )
  })
}
