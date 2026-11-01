import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentUse, Board, Team } from '../types'

const PANE = 'equipes'
const TITLE = 'Équipes'
const TAG = 'property-explorer'
const SERVERS = ['claude-code-remote', 'claude_code_remote']
const REFRESH_MS = 120_000

const board = atom({ plugin: 'equipes', key: 'board' } as const, { teams: [], fetchedAt: null, error: null }, { shape: 'board-1' })
const agentUse = atom({ plugin: 'equipes', key: 'agentUse' } as const, {}, { shape: 'use-1' })
const collapsed = atom({ plugin: 'equipes', key: 'collapsed' } as const, { done: true }, { shape: 'col-1' })

// ── Lecture des sessions ─────────────────────────────────────────────────────

type Json = Record<string, unknown>

const parse = (text: string): Json | null => {
  const a = text.indexOf('{')
  const b = text.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try {
    const v = JSON.parse(text.slice(a, b + 1)) as Json
    return (v.ccr as Json | undefined) ?? v
  } catch {
    return null
  }
}

async function callRemote($: EngineInterface, tool: string, args: Record<string, unknown>): Promise<Json | null> {
  for (const server of SERVERS) {
    try {
      const r = await $.mcp.call(server, tool, args)
      if (r.isError) continue
      const text = r.content.map(c => c.text ?? '').join('')
      const json = parse(text)
      if (json) return json
    } catch {
      // serveur absent sous ce nom : on essaie le suivant
    }
  }
  return null
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

async function refresh($: EngineInterface): Promise<void> {
  const list = await callRemote($, 'list_sessions', { limit: 50, mine: true })
  const now = await $.clock.now()
  if (!list) {
    await update($, board, b => ({ ...b, fetchedAt: now, error: 'unreachable' }))
    return
  }
  const rows = (Array.isArray(list.data) ? list.data : []) as Json[]
  const mine = rows.filter(r => Array.isArray(r.tags) && (r.tags as unknown[]).includes(TAG))
  const teams: Team[] = []
  for (const r of mine) {
    const id = str(r.id)
    if (!id) continue
    const team: Team = {
      id,
      title: str(r.title) ?? id,
      bucket: str(r.status_bucket) ?? 'UNKNOWN',
      summary: str(r.task_summary) ?? str((r.post_turn_summary as Json | undefined)?.recent_action),
    }
    const detail = await callRemote($, 'get_session', { session_id: id })
    const meta = (detail?.external_metadata as Json | undefined) ?? {}
    const ctx = (meta.context_usage as Json | undefined) ?? {}
    team.model = str(meta.last_served_model) ?? str((detail?.session_context as Json | undefined)?.model)
    team.ctxUsed = num(ctx.used_tokens)
    team.ctxMax = num(ctx.max_tokens)
    team.summary = team.summary ?? str(detail?.task_summary)
    teams.push(team)
  }
  teams.sort((a, b) => a.title.localeCompare(b.title, 'fr'))
  await update($, board, () => ({ teams, fetchedAt: now, error: null }))
  const active = teams.filter(t => t.bucket.endsWith('WORKING')).length
  $.ui.status(teams.length ? `équipes ${active}/${teams.length} actives` : undefined)
}

// ── Présentation ─────────────────────────────────────────────────────────────

type Group = 'run' | 'wait' | 'done'

const groupOf = (bucket: string): Group =>
  bucket.endsWith('WORKING') ? 'run' : bucket.endsWith('BLOCKED') || bucket.endsWith('REVIEW_READY') ? 'wait' : 'done'

const STATUS: Record<string, { label: string; color: string }> = {
  WORKING: { label: 'en cours', color: '#4C8DF6' },
  BLOCKED: { label: 'bloquée', color: '#E5A23D' },
  REVIEW_READY: { label: 'en attente', color: '#3FB68B' },
  COMPLETED: { label: 'terminée', color: '#8A93A3' },
  FAILED: { label: 'échec', color: '#E5484D' },
}

const statusOf = (bucket: string) => {
  const key = Object.keys(STATUS).find(k => bucket.endsWith(k))
  return key ? STATUS[key]! : { label: 'inconnu', color: '#8A93A3' }
}

const compact = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}k` : String(n)

const ago = (at: number | null, now: number): string => {
  if (at === null) return '—'
  const s = Math.round((now - at) / 1000)
  return s < 60 ? 'à l’instant' : `il y a ${Math.round(s / 60)} min`
}

const bar = (percent: number, width = 28): [string, string] => {
  const full = Math.round((Math.max(0, Math.min(100, percent)) / 100) * width)
  return ['━'.repeat(full), '━'.repeat(width - full)]
}

const prettyModel = (id?: string): string => {
  if (!id) return ''
  const m = /claude-([a-z]+)-(\d+)-(\d+)/.exec(id)
  return m ? `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)} ${m[2]}.${m[3]}` : id
}

const shortTitle = (title: string): [string, string] => {
  const m = /^(PE \d+)\s*·\s*(.*)$/.exec(title)
  return m ? [m[1]!, m[2]!] : ['', title]
}

// Petit chef en pixels, toque comprise, teinté selon le statut.
const chef = (color: string): string => {
  const hat = ['..WWWW..', '.WWWWWW.', '..BBBB..']
  const body = ['.CCCCCC.', 'CCKCCKCC', 'CCCCCCCC', '.CCCCCC.', '.C.CC.C.']
  const fill: Record<string, string> = { W: '#F4F4F4', B: color, C: '#E07A5F', K: '#1A1A1A' }
  const rects = [...hat, ...body]
    .flatMap((r, y) => [...r].map((c, x) => (fill[c] ? `<rect x="${x}" y="${y}" width="1" height="1" fill="${fill[c]}"/>` : '')))
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8" shape-rendering="crispEdges">${rects}</svg>`
}

// ── Hooks ────────────────────────────────────────────────────────────────────

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'equipes', description: 'Ouvrir le panneau des équipes (statut, tâche, contexte)' })
    void refresh($)
    $.clock.every(REFRESH_MS, () => void refresh($))
    return next(e)
  })

  on('command.run', { command: 'equipes' }, async $ => {
    await refresh($)
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    const b = await read($, board)
    if (b.error) return { text: 'Équipes : impossible de lire les conversations depuis cette session.' }
    const lines = b.teams.map(t => `${statusOf(t.bucket).label.padEnd(10)} ${t.title}${t.summary ? ` — ${t.summary}` : ''}`)
    return { text: [opened.isPlaced ? 'Panneau Équipes ouvert.' : 'Équipes :', ...lines].join('\n') }
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const id = e.agentId
    const u = result.usage
    if (id && u) {
      const t = u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
      await update($, agentUse, m => {
        const prev: AgentUse = m[id] ?? { tokens: 0, requests: 0 }
        return { ...m, [id]: { tokens: prev.tokens + t, requests: prev.requests + 1 } }
      })
    }
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const Svg = 'Svg' in table ? table.Svg : undefined
    const Link = 'Link' in table ? table.Link : undefined
    const b: Board = await read($, board)
    const use = await read($, agentUse)
    const folded = await read($, collapsed)
    const now = await $.clock.now()
    const agents = await $.agent.list()

    const active = b.teams.filter(t => groupOf(t.bucket) === 'run').length
    const ctxTotal = b.teams.reduce((s, t) => s + (t.ctxUsed ?? 0), 0)

    const card = (label: string, value: string) => (
      <Box key={label} flexDirection="column" flexGrow={1} borderStyle="round" borderDimColor paddingX={1}>
        <Text dimColor size="caption">{label}</Text>
        <Text size="heading" weight="semibold" tabular>{value}</Text>
      </Box>
    )

    const toggle = (key: Group | 'agents', label: string, count: number) => (
      <Button
        key={`t-${key}`}
        plain
        label={`${folded[key] ? '▸' : '▾'} ${label} · ${count}`}
        onPress={() => void update($, collapsed, c => ({ ...c, [key]: !c[key] }))}
      />
    )

    const row = (t: Team) => {
      const st = statusOf(t.bucket)
      const [code, name] = shortTitle(t.title)
      const pct = t.ctxUsed && t.ctxMax ? Math.round((t.ctxUsed / t.ctxMax) * 100) : undefined
      const [filled, empty] = bar(pct ?? 0)
      return (
        <Box key={t.id} flexDirection="row" gap={1} paddingY={0}>
          {Svg ? <Svg source={chef(st.color)} alt={st.label} width={36} height={36} /> : <Text color={st.color}>●</Text>}
          <Box flexDirection="column" flexGrow={1} flexShrink={1}>
            <Box flexDirection="row" justifyContent="space-between">
              <Text weight="semibold" wrap="truncate">{code ? `${code} · ${name}` : name}</Text>
              <Text color={st.color}>●</Text>
            </Box>
            <Box flexDirection="row" gap={1}>
              <Text color={st.color}>{st.label}</Text>
              {t.model && <Text dimColor>{prettyModel(t.model)}</Text>}
            </Box>
            <Box flexDirection="row" justifyContent="space-between" gap={2}>
              <Text dimColor wrap="truncate">{t.summary ?? '—'}</Text>
              {pct !== undefined && <Text dimColor tabular>{`ctx ${pct}% · ${compact(t.ctxUsed!)}`}</Text>}
            </Box>
            {pct !== undefined && (
              <Text color={st.color}>{filled}<Text dimColor>{empty}</Text></Text>
            )}
            {Link && <Link href={`https://claude.ai/code/${t.id}`} label="Ouvrir la conversation" />}
          </Box>
        </Box>
      )
    }

    const groups: { key: Group; label: string }[] = [
      { key: 'run', label: 'En cours' },
      { key: 'wait', label: 'En attente' },
      { key: 'done', label: 'Terminées' },
    ]

    return (
      <Box flexDirection="column" gap={1} paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Text size="title" weight="semibold">Property Explorer</Text>
          <Button key="refresh" plain dimColor label="Actualiser" onPress={() => void refresh($)} />
        </Box>

        <Box flexDirection="row" gap={1}>
          {card('Actives', `${active}/${b.teams.length}`)}
          {card('Contexte', compact(ctxTotal))}
          {card('Mise à jour', ago(b.fetchedAt, now))}
        </Box>

        {b.error ? (
          <Box flexDirection="column" alignItems="center" paddingY={2} gap={1}>
            <Text size="heading">Conversations indisponibles</Text>
            <Text dimColor>Cette session n’a pas accès à la liste de tes conversations cloud.</Text>
            <Button key="retry" label="Réessayer" variant="secondary" onPress={() => void refresh($)} />
          </Box>
        ) : b.fetchedAt === null ? (
          <Text dimColor>Chargement des équipes…</Text>
        ) : (
          groups.map(g => {
            const list = b.teams.filter(t => groupOf(t.bucket) === g.key)
            if (list.length === 0) return null
            return (
              <Box key={g.key} flexDirection="column" gap={1}>
                {toggle(g.key, g.label, list.length)}
                {!folded[g.key] && list.map(row)}
              </Box>
            )
          })
        )}

        {agents.length > 0 && (
          <Box flexDirection="column" gap={1}>
            {toggle('agents', 'Sous-agents de cette session', agents.length)}
            {!folded.agents &&
              agents.map(a => {
                const u = use[a.id]
                const running = a.status === 'running' || a.status === 'pending'
                return (
                  <Box key={a.id} flexDirection="row" justifyContent="space-between" gap={2}>
                    <Text wrap="truncate">{a.name ?? a.description}</Text>
                    <Text dimColor tabular>{`${running ? 'en cours' : a.status} · ${u ? compact(u.tokens) : '0'} tokens`}</Text>
                  </Box>
                )
              })}
          </Box>
        )}
      </Box>
    )
  })
}
