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

const bar = (remaining: number, width = 8) => {
  const filled = Math.round((Math.max(0, Math.min(100, remaining)) / 100) * width)
  return '▰'.repeat(filled) + '▱'.repeat(width - filled)
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

/** Bar of what's left, with a ┃ at where the clock says you'd be on an even pace. */
const paced = (remaining: number, timeLeftPct: number | null, width = 24) => {
  const filled = Math.round((remaining / 100) * width)
  const cells: string[] = Array.from({ length: width }, (_, i) => (i < filled ? '▰' : '▱'))
  if (timeLeftPct !== null) {
    const at = Math.min(width - 1, Math.max(0, Math.round((timeLeftPct / 100) * width) - 1))
    cells[at] = '┃'
  }
  return cells.join('')
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
    const s = await read($, snapshot)
    if (e.props.hasSurvey || s === null) return next(e)

    const open = await read($, isOpen)
    const stamp = await read($, clockNow)
    const m = fresh(await read($, meta))
    const compact = await read($, isCompact)
    const now = stamp || (await $.clock.now())
    const { Box, Text, Button } = $.ui.resolve(e)

    const rows = s.rateLimits.map(r => rowFor(r, now))
    const ctxPct = s.tokens === null ? null : Math.min(100, (s.tokens / s.window) * 100)
    const sessionMs = m.startedAt ? now - m.startedAt : 0

    if (compact) {
      const worst = rows.reduce<Row | null>((a, r) => (a === null || r.remaining < a.remaining ? r : a), null)
      const five = rows.find(r => r.kind === 'five_hour') ?? worst
      return (
        <Box>
          <Text color={worst ? tone(worst.remaining) : undefined}>● </Text>
          {rows.map(row => (
            <Text key={row.kind} dimColor>
              {label[row.kind] ?? row.kind} {row.remaining.toFixed(0)}%{'  '}
            </Text>
          ))}
          {five?.msLeft != null ? (
            <Text dimColor>⟳ {countdown(five.msLeft, five.kind === 'five_hour' && five.msLeft < HOUR)}{'  '}</Text>
          ) : null}
          <Button key="expand" dimColor label="▸" onPress={() => update($, isCompact, () => false)} />
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box>
          {rows.map(row => {
            const fiveH = row.kind === 'five_hour'
            return (
              <Text key={row.kind}>
                <Text dimColor>{label[row.kind] ?? row.kind} </Text>
                <Text color={tone(row.remaining)}>{bar(row.remaining)}</Text>
                <Text> {row.remaining.toFixed(0)}%</Text>
                {row.runsOutIn !== null ? <Text color="warning"> ↯</Text> : null}
                {row.msLeft !== null ? (
                  <Text dimColor> ⟳ {countdown(row.msLeft, fiveH && row.msLeft < HOUR)}</Text>
                ) : null}
                <Text dimColor>{'   '}</Text>
              </Text>
            )
          })}
          {ctxPct !== null && s.tokens !== null ? (
            <Text>
              <Text dimColor>ctx </Text>
              <Text color="suggestion">{bar(100 - ctxPct, 4)}</Text>
              <Text dimColor> {ctxPct.toFixed(0)}%{'   '}</Text>
            </Text>
          ) : null}
          {s.usd !== null ? <Text dimColor>${s.usd.toFixed(2)}{'   '}</Text> : null}
          {rows.length === 0 && s.tokens === null ? (
            <Text dimColor>usage: no data yet{'   '}</Text>
          ) : null}
          <Button
            key="toggle"
            dimColor
            label={open ? '▾' : '▸'}
            onPress={() => update($, isOpen, v => !v)}
          />
        </Box>
        {open ? (
          <Box flexDirection="column" paddingLeft={2}>
            {rows.map(row => (
              <Box key={row.kind} flexDirection="column">
                <Text>
                  <Text bold>{(label[row.kind] ?? row.kind).padEnd(6)}</Text>
                  <Text color={tone(row.remaining)}>
                    {paced(row.remaining, row.timeLeftPct)}
                  </Text>
                  <Text> {row.remaining.toFixed(0)}% left</Text>
                  <Text dimColor> ({row.used}% used)</Text>
                </Text>
                <Text dimColor>
                  {'      '}
                  {row.msLeft !== null
                    ? `resets in ${countdown(row.msLeft, true)}${
                        row.resetsAt ? ` (${clockTime(row.resetsAt)})` : ''
                      }`
                    : 'no reset time'}
                  {row.runsOutIn !== null
                    ? `  ·  at this pace runs out in ${span(row.runsOutIn)}`
                    : row.timeLeftPct !== null
                      ? '  ·  pace is fine'
                      : ''}
                </Text>
              </Box>
            ))}
            {rows.length > 0 ? (
              <Text dimColor>{'      '}┃ = where an even pace would be right now</Text>
            ) : null}
            {ctxPct !== null && s.tokens !== null ? (
              <Text>
                <Text bold>{'ctx'.padEnd(6)}</Text>
                <Text color="suggestion">{paced(100 - ctxPct, null)}</Text>
                <Text dimColor>
                  {' '}
                  {fmt(s.tokens)} / {fmt(s.window)} tokens ({ctxPct.toFixed(0)}% full)
                </Text>
              </Text>
            ) : null}
            {m.last ? (
              <Text dimColor>
                {'last'.padEnd(6)} {m.last.seconds}s · {fmt(m.last.output)} out
                {m.last.cachePct !== null ? ` · cache ${m.last.cachePct.toFixed(0)}%` : ''}
                {m.last.usd !== null ? ` · $${m.last.usd.toFixed(2)}` : ''}
              </Text>
            ) : null}
            <Text dimColor>
              {'session'.padEnd(6)} {span(sessionMs)} · {m.turns} turns
              {s.usd !== null
                ? ` · $${s.usd.toFixed(2)}${
                    sessionMs > 10 * MIN
                      ? ` · $${((s.usd / sessionMs) * HOUR).toFixed(2)}/h`
                      : ''
                  }`
                : ''}
            </Text>
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
  })
}
