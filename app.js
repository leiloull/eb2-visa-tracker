const DAY = 24 * 60 * 60 * 1000
const $ = (id) => document.getElementById(id)

// 云端只读配置（publishable key 公开、仅 SELECT 权限，写令牌不下发到 App）
const CLOUD_ENDPOINT = 'https://eb2-visa-tracker.app.workbuddy.host'
const CLOUD_KEY = 'wbpk_9N3WXfC4SrYcG0jgk4vCS4_B9udhh7KquV0cjRJHwZy75nUuPm5862P'
const isNativeApp = () => Boolean(window.Capacitor?.isNativePlatform?.())
const isDate = (value) => Boolean(value) && /^\d{4}-\d{2}-\d{2}$/.test(String(value))

const isoDate = (value) => (value ? String(value).slice(0, 10) : null)

function normalizePrediction(row) {
  if (!row) return null
  return {
    targetMonth: isoDate(row.target_month),
    finalActionDate: isoDate(row.predicted_final_action_date),
    filingDate: isoDate(row.predicted_filing_date),
    method: row.method,
    basis: Array.isArray(row.basis) ? row.basis : [],
    stats: row.stats && typeof row.stats === 'object' ? row.stats : null,
    basedOnMonth: isoDate(row.based_on_month) || null,
  }
}

/** App 内直连云数据库：无需本地后端即可取实时数据 */
async function fetchCloudData() {
  const headers = { 'x-wb-webapp-access-key': CLOUD_KEY }
  const base = `${CLOUD_ENDPOINT}/.cloud/database/rest`
  const [bRes, pRes] = await Promise.all([
    fetch(`${base}/eb2_bulletin?select=*&order=month.asc`, { headers, cache: 'no-store' }),
    fetch(`${base}/eb2_prediction?select=*&order=target_month.desc&limit=1`, { headers, cache: 'no-store' }),
  ])
  if (!bRes.ok || !pRes.ok) throw new Error(`云端 HTTP ${bRes.status}/${pRes.status}`)
  const [bulletinRows, predictionRows] = await Promise.all([bRes.json(), pRes.json()])
  const bulletins = (bulletinRows || []).map((row) => ({
    month: isoDate(row.month),
    finalActionDate: isoDate(row.final_action_date),
    filingDate: isoDate(row.filing_date),
    sourceUrl: row.source_url,
  }))
  if (!bulletins.length) throw new Error('云端暂无数据')
  return { ok: true, bulletins, prediction: normalizePrediction(predictionRows?.[0]) }
}

function fmtDate(value) {
  if (!value) return '—'
  if (value === 'CURRENT') return 'Current（无排期）'
  if (value === 'UNAVAILABLE') return 'Unavailable'
  const [y, m, d] = String(value).split('-')
  return `${y}年${Number(m)}月${Number(d)}日`
}

function fmtMonth(value) {
  if (!value) return '—'
  const [y, m] = String(value).split('-')
  return `${y}年${Number(m)}月`
}

function diffDays(from, to) {
  if (!isDate(from) || !isDate(to)) return null
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY)
}

function deltaHtml(days) {
  if (days === null || days === undefined) return '<span class="delta-flat">—</span>'
  if (days === 0) return '<span class="delta-flat">持平</span>'
  if (days > 0) return `<span class="delta-up">前进 ${days} 天</span>`
  return `<span class="delta-down">倒退 ${Math.abs(days)} 天</span>`
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c])
}

function showNotice(message, isError = false) {
  const el = $('notice')
  el.textContent = message
  el.classList.remove('hidden')
  el.classList.toggle('error', isError)
}

function renderCards(bulletins, prediction) {
  const latest = bulletins[bulletins.length - 1]
  if (!latest) return
  $('current-a').textContent = fmtDate(latest.finalActionDate)
  $('current-b').textContent = fmtDate(latest.filingDate)
  $('current-a-month').textContent = `${fmtMonth(latest.month)} 公告`
  $('current-b-month').textContent = `${fmtMonth(latest.month)} 公告`

  $('predict-a').textContent = prediction ? fmtDate(prediction.finalActionDate) : '—'
  $('predict-b').textContent = prediction ? fmtDate(prediction.filingDate) : '—'
  $('predict-month').textContent = prediction ? `预测 ${fmtMonth(prediction.targetMonth)}` : '暂无预测'
  $('predict-note').textContent = prediction ? `依据 ${fmtMonth(prediction.basedOnMonth || latest.month)} 及上一期` : '—'
}

function renderChart(bulletins) {
  const width = 760
  const height = 240
  const pad = { l: 62, r: 14, t: 14, b: 32 }
  const pointsA = bulletins
    .map((row, index) => ({ index, value: row.finalActionDate }))
    .filter((p) => isDate(p.value))
  const pointsB = bulletins
    .map((row, index) => ({ index, value: row.filingDate }))
    .filter((p) => isDate(p.value))
  const all = [...pointsA, ...pointsB].map((p) => Date.parse(`${p.value}T00:00:00Z`))
  if (!all.length || bulletins.length < 2) {
    $('chart').innerHTML = '<p style="color:var(--muted);font-size:13px">暂无足够数据绘制走势图</p>'
    return
  }

  const minT = Math.min(...all)
  const maxT = Math.max(...all)
  const range = maxT - minT || DAY
  const x = (index) => pad.l + (index / (bulletins.length - 1)) * (width - pad.l - pad.r)
  const y = (value) => pad.t + (1 - (Date.parse(`${value}T00:00:00Z`) - minT) / range) * (height - pad.t - pad.b)

  const grid = [0, 0.5, 1].map((ratio) => {
    const gy = pad.t + ratio * (height - pad.t - pad.b)
    const label = new Date(minT + range * (1 - ratio)).toISOString().slice(0, 7)
    return `<line x1="${pad.l}" y1="${gy}" x2="${width - pad.r}" y2="${gy}" stroke="#263241" stroke-width="1" />
      <text x="${pad.l - 8}" y="${gy + 4}" fill="#90a0b5" font-size="10" text-anchor="end">${label}</text>`
  }).join('')

  const labels = [0, Math.floor((bulletins.length - 1) / 2), bulletins.length - 1]
    .map((index) => `<text x="${x(index)}" y="${height - 8}" fill="#90a0b5" font-size="10" text-anchor="middle">${fmtMonth(bulletins[index].month)}</text>`)
    .join('')

  const line = (points, color) => {
    if (!points.length) return ''
    const coords = points.map((p) => `${x(p.index)},${y(p.value)}`).join(' ')
    const circles = points.map((p) => `<circle cx="${x(p.index)}" cy="${y(p.value)}" r="3.5" fill="${color}" stroke="#0b0f14" stroke-width="1.5"><title>${fmtMonth(bulletins[p.index].month)} · ${fmtDate(p.value)}</title></circle>`).join('')
    return `<polyline points="${coords}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" />${circles}`
  }

  $('chart').innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="EB-2 中国排期走势图">
    ${grid}
    ${line(pointsA, '#6ea8ff')}
    ${line(pointsB, '#45d6c3')}
    ${labels}
  </svg>`
}

function renderBasis(prediction) {
  if (!prediction?.basis?.length) {
    $('method-text').textContent = '暂无预测依据'
    $('basis-list').innerHTML = ''
    return
  }
  $('method-text').textContent = prediction.method || '—'
  const stats = prediction.stats
  const statsHtml = stats?.finalAction
    ? `<div class="basis-item">
        <strong>全期趋势</strong>
        <span>${stats.totalMonths ?? '—'} 期样本 · ${stats.finalAction.samples} 个有效日期</span>
        <span>A 净推进 ${stats.finalAction.netDays} 天 / 月均 ${stats.finalAction.avgDaysPerMonth} 天 · B 月均 ${stats.filing?.avgDaysPerMonth ?? '—'} 天</span>
      </div>`
    : ''
  $('basis-list').innerHTML = statsHtml + prediction.basis.map((row) => `
    <div class="basis-item">
      <strong>${escapeHtml(fmtMonth(row.month))}</strong>
      <span>A ${escapeHtml(fmtDate(row.finalActionDate))} · B ${escapeHtml(fmtDate(row.filingDate))}</span>
      <span>${deltaHtml(row.deltaDaysA)} / ${deltaHtml(row.deltaDaysB)}</span>
    </div>
  `).join('')
}

function renderHistory(bulletins) {
  const reversed = [...bulletins].reverse()
  $('history-body').innerHTML = reversed.map((row, index) => {
    const previous = reversed[index + 1]
    const deltaA = previous ? diffDays(previous.finalActionDate, row.finalActionDate) : null
    const deltaB = previous ? diffDays(previous.filingDate, row.filingDate) : null
    const source = row.sourceUrl
      ? `<a href="${escapeHtml(row.sourceUrl)}" target="_blank" rel="noreferrer">官方公告 ↗</a>`
      : '—'
    return `<tr>
      <td>${escapeHtml(fmtMonth(row.month))}</td>
      <td>${escapeHtml(fmtDate(row.finalActionDate))}</td>
      <td>${deltaHtml(deltaA)}</td>
      <td>${escapeHtml(fmtDate(row.filingDate))}</td>
      <td>${deltaHtml(deltaB)}</td>
      <td>${source}</td>
    </tr>`
  }).join('')
}

function render(data) {
  const bulletins = (data.bulletins || []).filter((row) => row.month).sort((a, b) => a.month.localeCompare(b.month))
  renderCards(bulletins, data.prediction)
  renderChart(bulletins)
  renderBasis(data.prediction)
  renderHistory(bulletins)
  const latest = bulletins[bulletins.length - 1]
  if (latest) $('source-badge').textContent = `最新公告：${fmtMonth(latest.month)}`
}

async function loadData(showSuccess = false) {
  const sources = []
  // 原生 App 优先云端直连；网页端仍优先本地后端（可用时才尝试）
  if (isNativeApp()) {
    sources.push({ name: 'cloud', run: fetchCloudData })
    sources.push({ name: 'local', run: async () => {
      const res = await fetch('/api/data', { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    } })
  } else {
    sources.push({ name: 'local', run: async () => {
      const res = await fetch('/api/data', { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    } })
    sources.push({ name: 'cloud', run: fetchCloudData })
  }

  let lastError
  for (const source of sources) {
    try {
      const data = await source.run()
      if (!data?.ok) throw new Error(data?.error || '返回失败')
      render(data)
      if (showSuccess) showNotice('数据已刷新。')
      else $('notice').classList.add('hidden')
      return source.name
    } catch (error) {
      lastError = error
    }
  }

  const seed = JSON.parse($('seed-data').textContent)
  render(seed)
  showNotice(`实时数据暂不可用（${lastError?.message || '网络异常'}），当前显示内置数据。`, true)
  return 'seed'
}

async function scrapeNow() {
  const button = $('scrape-btn')
  if (isNativeApp()) {
    // App 内只读：抓取由云端定时任务负责，这里只做刷新
    button.disabled = true
    button.textContent = '刷新中…'
    try {
      const source = await loadData(true)
      if (source === 'seed') showNotice('刷新失败，当前为内置数据，请检查网络。', true)
    } finally {
      button.disabled = false
      button.textContent = '刷新数据'
    }
    return
  }
  if (location.protocol === 'file:') {
    showNotice('请先运行 npm start 启动后端，再使用抓取功能。', true)
    return
  }
  button.disabled = true
  button.textContent = '抓取中…'
  try {
    const res = await fetch('/api/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    const data = await res.json()
    if (!res.ok || !data.ok) throw new Error(data.error || '抓取失败')
    await loadData()
    showNotice(`抓取完成：${data.scrapedCount} 条记录，已更新 ${data.prediction?.targetMonth ? fmtMonth(data.prediction.targetMonth) : '下期'} 预测。`)
  } catch (error) {
    showNotice(`抓取失败：${error.message}`, true)
  } finally {
    button.disabled = false
    button.textContent = '刷新数据'
  }
}

$('scrape-btn').addEventListener('click', scrapeNow)
loadData()
