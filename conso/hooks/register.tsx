import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { LastTurn, Limit, Measure, Totals } from '../types'

const PANE = 'conso'
const TITLE = 'Conso'

const ZERO: Totals = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

const totals = atom({ plugin: 'conso', key: 'totals' } as const, ZERO, { shape: 'totals-1' })
const measure = atom({ plugin: 'conso', key: 'measure' } as const, null, { shape: 'measure-1' })
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

const statusLine = (m: Measure | null, t: Totals): string => {
  const parts: string[] = []
  if (m?.contextPercent !== undefined) parts.push(`◔ ${m.contextPercent}%`)
  const hit = hitRate(t)
  if (hit !== undefined) parts.push(`cache ${hit}%`)
  if (m?.costUsd !== undefined) parts.push(usd(m.costUsd))
  return parts.join(' · ')
}

async function refreshStatus($: EngineInterface): Promise<void> {
  const text = statusLine(await read($, measure), await read($, totals))
  $.ui.status(text === '' ? undefined : text)
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
    void $.ui.open({ id: PANE, title: TITLE })
    return next(e)
  })

  // Une interface qui se connecte plus tard reçoit le panneau automatiquement.
  on('session.attach', async ($, e, next) => {
    const r = await next(e)
    void $.ui.open({ id: PANE, title: TITLE })
    return r
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
    await refreshStatus($)
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
      const snapshot = turn
      await update($, lastTurn, () => snapshot)
      await refreshStatus($)
    }
    return result
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
