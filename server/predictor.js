const pad = (n) => String(n).padStart(2, '0')
const DAY = 24 * 60 * 60 * 1000
const CUTOFF_DAYS = [1, 8, 15, 22] // DOS 常用 cutoff 日
const MAX_MONTHLY_ADVANCE = 180 // 单月预测上限，避免异常值造成荒谬外推

function iso(value) {
  if (!value) return null
  return String(value).slice(0, 10)
}

function toTime(date) {
  return Date.parse(`${date}T00:00:00Z`)
}

function fromTime(time) {
  return new Date(time).toISOString().slice(0, 10)
}

export function addMonths(monthIso, count) {
  const [year, month] = String(monthIso).slice(0, 7).split('-').map(Number)
  const total = year * 12 + (month - 1) + count
  return `${Math.floor(total / 12)}-${pad((total % 12) + 1)}-01`
}

function monthDiff(fromMonth, toMonth) {
  const [y1, m1] = fromMonth.slice(0, 7).split('-').map(Number)
  const [y2, m2] = toMonth.slice(0, 7).split('-').map(Number)
  return y2 * 12 + (m2 - 1) - (y1 * 12 + (m1 - 1))
}

function isRealDate(value) {
  return Boolean(value) && !['CURRENT', 'UNAVAILABLE'].includes(value) && !Number.isNaN(toTime(value))
}

function daysBetween(from, to) {
  return Math.round((toTime(to) - toTime(from)) / DAY)
}

/** 把预测日期吸附到 DOS 常用的 1/8/15/22 日 */
function snapToCutoff(date) {
  if (!isRealDate(date)) return date
  const [year, month, day] = date.split('-').map(Number)
  let best = null
  for (const candidateDay of CUTOFF_DAYS) {
    const candidate = Date.UTC(year, month - 1, candidateDay)
    const distance = Math.abs(candidate - toTime(date))
    if (!best || distance < best.distance) best = { date: fromTime(candidate), distance }
  }
  return best.date
}

/** 对全部可用历史点做一元线性回归，得到每月平均推进天数 */
function linearTrend(points) {
  if (points.length < 2) return null
  const meanX = points.reduce((sum, p) => sum + p.x, 0) / points.length
  const meanY = points.reduce((sum, p) => sum + p.y, 0) / points.length
  let numerator = 0
  let denominator = 0
  for (const p of points) {
    numerator += (p.x - meanX) * (p.y - meanY)
    denominator += (p.x - meanX) ** 2
  }
  if (!denominator) return null
  return numerator / denominator / DAY // 天/月
}

function predictField(rows, field, firstMonth) {
  const last = rows[rows.length - 1][field]
  if (!isRealDate(last)) {
    return { date: last ?? null, slope: null, note: '上期非具体日期，沿用上期状态', stats: null }
  }

  const points = rows
    .filter((row) => isRealDate(row[field]))
    .map((row) => ({ x: monthDiff(firstMonth, row.month), y: toTime(row[field]) }))

  const slopeRaw = linearTrend(points)
  if (slopeRaw === null) {
    return { date: last, slope: null, note: '历史样本不足，沿用上期', stats: null }
  }

  const slope = Math.max(0, Math.min(MAX_MONTHLY_ADVANCE, slopeRaw))
  const span = points.length > 1 ? points[points.length - 1].x - points[0].x : 0
  const netDays = span > 0 ? (points[points.length - 1].y - points[0].y) / DAY : 0
  const stats = {
    samples: points.length,
    spanMonths: span,
    netDays: Math.round(netDays),
    avgDaysPerMonth: span > 0 ? Math.round((netDays / span) * 10) / 10 : 0,
    slopeDaysPerMonth: Math.round(slope * 10) / 10,
    capped: slopeRaw > MAX_MONTHLY_ADVANCE || slopeRaw < 0,
  }

  const advanced = fromTime(toTime(last) + slope * DAY)
  return {
    date: snapToCutoff(advanced),
    slope: stats.slopeDaysPerMonth,
    note: slope === 0 ? '全期趋势为持平或倒退，保守预测维持上期' : '按全期历史趋势线性外推',
    stats,
  }
}

/**
 * 基于全部历史排期（默认近 5 年）预测下一个月。
 * rows: [{ month, finalActionDate, filingDate }]，日期为 YYYY-MM-DD 或 CURRENT/UNAVAILABLE
 */
export function predictNext(rows) {
  const sorted = rows
    .filter((row) => row?.month)
    .map((row) => ({
      month: iso(row.month),
      finalActionDate: iso(row.finalActionDate),
      filingDate: iso(row.filingDate),
    }))
    .sort((a, b) => a.month.localeCompare(b.month))

  if (!sorted.length) throw new Error('没有可用于预测的排期数据')

  const last = sorted[sorted.length - 1]
  const firstMonth = sorted[0].month
  const targetMonth = addMonths(last.month, 1)

  // 只使用最近 5 年（60 期）作为整体样本
  const window = sorted.slice(-60)
  const windowFirst = window[0].month

  const finalAction = predictField(window, 'finalActionDate', windowFirst)
  const filing = predictField(window, 'filingDate', windowFirst)

  const sampleCount = finalAction.stats?.samples ?? filing.stats?.samples ?? 0
  const method = [
    `基于近 5 年 ${sorted.length} 期数据中的 ${sampleCount} 个有效日期点`,
    `表A 趋势 ${finalAction.slope ?? 0} 天/月，表B 趋势 ${filing.slope ?? 0} 天/月（全期线性回归）`,
    '仅供参考，不构成法律意见',
  ].join('；')

  const basis = window.slice(-6).map((row, index, arr) => {
    const previous = index > 0 ? arr[index - 1] : null
    return {
      month: row.month,
      finalActionDate: row.finalActionDate,
      filingDate: row.filingDate,
      deltaDaysA: previous && isRealDate(previous.finalActionDate) && isRealDate(row.finalActionDate)
        ? daysBetween(previous.finalActionDate, row.finalActionDate)
        : null,
      deltaDaysB: previous && isRealDate(previous.filingDate) && isRealDate(row.filingDate)
        ? daysBetween(previous.filingDate, row.filingDate)
        : null,
    }
  })

  return {
    targetMonth,
    finalActionDate: finalAction.date,
    filingDate: filing.date,
    method,
    basis,
    stats: { finalAction: finalAction.stats, filing: filing.stats, totalMonths: sorted.length },
    basedOnMonth: last.month,
    generatedAt: new Date().toISOString(),
  }
}
