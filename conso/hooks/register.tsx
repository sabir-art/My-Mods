import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { LastTurn, Limit, Measure, Totals } from '../types'

const PANE = 'conso'
const TITLE = 'Conso'

const ZERO: Totals = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

const totals = atom({ plugin: 'conso', key: 'totals' } as const, ZERO, { shape: 'totals-1' })
const measure = atom({ plugin: 'conso', key: 'measure' } as const, null, { shape: 'measure-1' })
const lastRequestAt = atom({ plugin: 'conso', key: 'lastRequestAt' } as const, null, { shape: 'at-1' })
const lastTurn = atom({ plugin: 'conso', key: 'lastTurn' } as const, null, { shape: 'last-1' })

// ── Formatage ────────────────────────────────────────────────────────────────

const compact = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`
  return String(Math.round(n))
}

const usd = (n?: number): string =>
  n === undefined ? '—' : n < 10 ? `$${n.toFixed(2)}` : `$${Math.round(n)}`

const bar = (percent: number, width = 18): string => {
  const p = Math.max(0, Math.min(100, percent))
  const full = Math.round((p / 100) * width)
  return '━'.repeat(full) + '╌'.repeat(width - full)
}

const tone = (percent: number) => (percent >= 85 ? 'error' : percent >= 60 ? 'warning' : 'success')

const hitRate = (t: Totals): number | undefined => {
  const prompt = t.input + t.cacheRead + t.cacheWrite
  return prompt === 0 ? undefined : Math.round((t.cacheRead / prompt) * 100)
}

const limitName = (kind: string): string =>
  kind === 'five_hour' ? '5 h' : kind === 'seven_day' ? '7 j' : kind === 'spend_limit' ? 'Budget' : kind

const resetIn = (iso?: string, now?: number): string => {
  if (!iso || now === undefined) return ''
  const ms = Date.parse(iso) - now
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const h = Math.floor(ms / 3_600_000)
  const m = Math.round((ms % 3_600_000) / 60_000)
  if (h >= 24) return `reprise ${Math.round(h / 24)} j`
  return h > 0 ? `reprise ${h} h ${String(m).padStart(2, '0')}` : `reprise ${m} min`
}

// ── Bande au-dessus de la saisie ─────────────────────────────────────────────

// Durée de vie du cache de prompt dans Claude Code (1 h).
const CACHE_TTL_MS = 60 * 60 * 1000

const WINDOW_COLOR: Record<string, string> = { seven_day: '#F07A3A', five_hour: '#F2B33D', spend_limit: '#E8C26A' }

const shortWindow = (kind: string): string =>
  kind === 'five_hour' ? '5H' : kind === 'seven_day' ? '7J' : kind === 'spend_limit' ? '$' : kind.toUpperCase()

const span = (ms: number): string => {
  const min = Math.max(0, Math.round(ms / 60_000))
  const d = Math.floor(min / 1440)
  const h = Math.floor((min % 1440) / 60)
  const m = min % 60
  if (d > 0) return `${d} j ${h} h`
  if (h > 0) return `${h} h ${String(m).padStart(2, '0')}`
  return `${m} min`
}

const dots = (leftPercent: number, count = 10): [string, string] => {
  const full = Math.round((Math.max(0, Math.min(100, leftPercent)) / 100) * count)
  return ['●'.repeat(full), '·'.repeat(count - full)]
}

type CacheState = { label: string; bg: string; fg: string; left: string }

const cacheState = (at: number | null, now: number): CacheState | null => {
  if (at === null) return null
  const leftMs = CACHE_TTL_MS - (now - at)
  if (leftMs <= 0) return { label: 'FROID', bg: '#5B6472', fg: '#E6E9EE', left: 'expiré' }
  const ratio = leftMs / CACHE_TTL_MS
  if (ratio > 0.75) return { label: 'CHAUD', bg: '#E5484D', fg: '#1A1A1A', left: span(leftMs) }
  if (ratio > 0.25) return { label: 'TIÈDE', bg: '#E07A7A', fg: '#1A1A1A', left: span(leftMs) }
  return { label: 'FRAIS', bg: '#7AA7E0', fg: '#1A1A1A', left: span(leftMs) }
}

const invader = (color: string): string => {
  const rows = ['00100100', '00011000', '00111100', '01011010', '11111111', '10111101', '10100101', '00011000']
  const px = rows
    .flatMap((r, y) => [...r].map((c, x) => (c === '1' ? `<rect x="${x}" y="${y}" width="1" height="1"/>` : '')))
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8" shape-rendering="crispEdges" fill="${color}">${px}</svg>`
}

// ── Hooks ────────────────────────────────────────────────────────────────────

export const register: Register = on => {
  let turnId = ''
  let turn: LastTurn = { ...ZERO, model: '' }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'conso', description: 'Ouvrir le panneau de consommation (tokens, cache, coût)' })
    const u = await $.session.usage()
    await update($, measure, () => ({
      contextTokens: u.context.tokens,
      contextWindow: u.context.window,
      contextPercent: u.context.percent,
      costUsd: u.cost?.usd,
      limits: u.rateLimits.map(r => ({ kind: r.kind, percent: r.percentUsed, resetsAt: r.resetsAt })),
    }))
    // Fait vivre le compte à rebours du cache.
    $.clock.every(30_000, () => $.ui.invalidate('ui.render'))
    return next(e)
  })

  on('command.run', { command: 'conso' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    const m = await read($, measure)
    const t = await read($, totals)
    const hit = hitRate(t)
    const lines = [
      `Coût ${usd(m?.costUsd)} · ${t.requests} requêtes`,
      m?.contextPercent !== undefined
        ? `Contexte ${m.contextPercent}% (${compact(m.contextTokens ?? 0)} / ${compact(m.contextWindow)})`
        : 'Contexte : disponible après la première réponse',
      `Cache ${hit === undefined ? '—' : `${hit}%`} · lu ${compact(t.cacheRead)} · écrit ${compact(t.cacheWrite)}`,
      `Tokens : entrée ${compact(t.input)} · sortie ${compact(t.output)}`,
      ...(m?.limits ?? []).map(l => `Limite ${limitName(l.kind)} : ${Math.round(l.percent)}% ${resetIn(l.resetsAt, Date.now())}`.trim()),
    ]
    const where = opened.isPlaced ? 'Panneau ouvert.' : `Panneau non affiché (${opened.reason}).`
    return { text: [where, ...lines].join('\n') }
  })

  on('session.measure', async ($, e, next) => {
    await update($, measure, () => ({
      contextTokens: e.context.tokens,
      contextWindow: e.context.window,
      contextPercent: e.context.percent,
      costUsd: e.cost?.usd,
      limits: e.rateLimits.map(r => ({ kind: r.kind, percent: r.percentUsed, resetsAt: r.resetsAt })),
    }))
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const u = result.usage
    if (u) {
      await update($, totals, t => ({
        requests: t.requests + 1,
        input: t.input + u.input_tokens,
        output: t.output + u.output_tokens,
        cacheRead: t.cacheRead + u.cache_read_input_tokens,
        cacheWrite: t.cacheWrite + u.cache_creation_input_tokens,
      }))
      if (result.turnId !== turnId) {
        turnId = result.turnId
        turn = { ...ZERO, model: u.model }
      }
      turn = {
        requests: turn.requests + 1,
        input: turn.input + u.input_tokens,
        output: turn.output + u.output_tokens,
        cacheRead: turn.cacheRead + u.cache_read_input_tokens,
        cacheWrite: turn.cacheWrite + u.cache_creation_input_tokens,
        model: u.model,
      }
      const at = await $.clock.now()
      await update($, lastRequestAt, () => at)
      const snapshot = turn
      await update($, lastTurn, () => snapshot)
      }
    return result
  })


  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const m = await read($, measure)
    const at = await read($, lastRequestAt)
    const now = await $.clock.now()
    const cache = cacheState(at, now)
    const limits = m?.limits ?? []
    if (limits.length === 0 && cache === null) return next(e)

    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const Svg = 'Svg' in table ? table.Svg : undefined
    const order = ['seven_day', 'five_hour', 'spend_limit']
    const sorted = [...limits].sort((x, y) => order.indexOf(x.kind) - order.indexOf(y.kind))

    return (
      <Box flexDirection="row" alignItems="center" flexWrap="wrap" columnGap={3} rowGap={0} paddingX={1}>
        <Text bold>USAGE</Text>
        {sorted.map(l => {
          const left = Math.max(0, Math.round(100 - l.percent))
          const color = left <= 15 ? '#E5484D' : WINDOW_COLOR[l.kind] ?? '#F2B33D'
          const [filled, empty] = dots(left)
          const reset = l.resetsAt ? span(Date.parse(l.resetsAt) - now) : ''
          return (
            <Box key={l.kind} flexDirection="row" alignItems="center" gap={1}>
              <Text dimColor bold>{shortWindow(l.kind)}</Text>
              <Text color={color}>{filled}<Text dimColor>{empty}</Text></Text>
              <Text bold tabular color={color}>{`${left} % restant`}</Text>
              {reset !== '' && <Text dimColor tabular>{`· ${reset}`}</Text>}
            </Box>
          )
        })}
        {cache && (
          <Box key="cache" flexDirection="row" alignItems="center" gap={1}>
            {Svg ? <Svg source={invader(cache.bg)} alt="Cache" width={18} height={18} /> : <Text color={cache.bg}>◆</Text>}
            <Text bold backgroundColor={cache.bg} color={cache.fg}>{` ${cache.label} `}</Text>
            <Text bold tabular color={cache.bg}>{cache.left === 'expiré' ? 'expiré' : `${cache.left} restant`}</Text>
          </Box>
        )}
        <Button key="details" label="Détails" variant="secondary" onPress={() => void $.ui.open({ id: PANE, title: TITLE })} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const m = await read($, measure)
    const t = await read($, totals)
    const last = await read($, lastTurn)
    const now = await $.clock.now()
    const hit = hitRate(t)

    const label = (children: string) => (
      <Text dimColor size="caption">{children}</Text>
    )

    const row = (label: string, value: string, hint?: string) => (
      <Box key={label} flexDirection="row" justifyContent="space-between">
        <Text dimColor>{label}</Text>
        <Box flexDirection="row" gap={1}>
          {hint !== undefined && <Text dimColor size="caption">{hint}</Text>}
          <Text tabular mono>{value}</Text>
        </Box>
      </Box>
    )

    const meter = (label: string, percent: number, detail: string) => (
      <Box key={label} flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text dimColor>{label}</Text>
          <Text tabular bold color={tone(percent)}>{`${percent}%`}</Text>
        </Box>
        <Text color={tone(percent)}>{bar(percent)}</Text>
        {detail !== '' && <Text dimColor size="caption">{detail}</Text>}
      </Box>
    )

    const ctxPercent = m?.contextPercent
    const promptTotal = t.input + t.cacheRead + t.cacheWrite

    return (
      <Box flexDirection="column" gap={1} paddingX={1}>
        {/* En-tête : coût */}
        <Box flexDirection="row" justifyContent="space-between" alignItems="flex-end">
          <Box flexDirection="column">
            {label('COÛT DE LA SESSION')}
            <Text size="title" weight="semibold" tabular color="claude">{usd(m?.costUsd)}</Text>
          </Box>
          <Text dimColor size="caption">{`${t.requests} requêtes`}</Text>
        </Box>

        {/* Contexte */}
        {ctxPercent !== undefined && m ? (
          meter('Contexte', ctxPercent, `${compact(m.contextTokens ?? 0)} / ${compact(m.contextWindow)} tokens`)
        ) : (
          <Box flexDirection="column">
            <Text dimColor>Contexte</Text>
            <Text dimColor size="caption">Disponible après la première réponse.</Text>
          </Box>
        )}

        {/* Cache */}
        <Box flexDirection="column">
          {label('CACHE')}
          {hit === undefined ? (
            <Text dimColor size="caption">Aucune requête mesurée pour l’instant.</Text>
          ) : (
            <Box flexDirection="column">
              <Box flexDirection="row" justifyContent="space-between">
                <Text dimColor>Taux de lecture</Text>
                <Text tabular bold color={hit >= 70 ? 'success' : hit >= 40 ? 'warning' : 'error'}>{`${hit}%`}</Text>
              </Box>
              <Text color={hit >= 70 ? 'success' : hit >= 40 ? 'warning' : 'error'}>{bar(hit)}</Text>
              {row('Lu', compact(t.cacheRead))}
              {row('Écrit', compact(t.cacheWrite))}
            </Box>
          )}
        </Box>

        {/* Tokens */}
        <Box flexDirection="column">
          {label('TOKENS CUMULÉS')}
          {row('Entrée (hors cache)', compact(t.input))}
          {row('Sortie', compact(t.output))}
          {row('Prompt total', compact(promptTotal))}
        </Box>

        {/* Dernier tour */}
        {last && (
          <Box flexDirection="column">
            {label('DERNIER TOUR')}
            {row(`${last.requests} req.`, `↑${compact(last.input + last.cacheRead + last.cacheWrite)}  ↓${compact(last.output)}`)}
            <Text dimColor size="caption" wrap="truncate">{last.model}</Text>
          </Box>
        )}

        {/* Limites */}
        {m && m.limits.length > 0 && (
          <Box flexDirection="column" gap={1}>
            {label('LIMITES DU COMPTE')}
            {m.limits.map((l: Limit) => meter(limitName(l.kind), Math.round(l.percent), resetIn(l.resetsAt, now)))}
          </Box>
        )}

        <Box flexDirection="row" justifyContent="flex-end">
          <Button
            key="reset"
            label="Remettre à zéro"
            plain
            dimColor
            onPress={async () => {
              await update($, totals, () => ZERO)
              await update($, lastTurn, () => null)
            }}
          />
        </Box>
      </Box>
    )
  })
}
