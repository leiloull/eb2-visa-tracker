import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import cron from 'node-cron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readBulletins, readLatestPrediction, writeBulletin, writePrediction } from './cloud.js'
import { scrape } from './scraper.js'
import { predictNext } from './predictor.js'

const app = express()
app.use(cors())
app.use(express.json())

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')

function asyncRoute(handler) {
  return (req, res) => Promise.resolve(handler(req, res)).catch((error) => {
    console.error('[api]', error)
    res.status(500).json({ ok: false, error: error.message ?? '服务器内部错误' })
  })
}

const pad = (n) => String(n).padStart(2, '0')
const monthKey = (date = new Date()) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}`

function hasMonth(bulletins, month) {
  return bulletins.some((row) => String(row.month).slice(0, 7) === month)
}

function changed(oldRow, record) {
  return oldRow.finalActionDate !== record.finalActionDate
    || oldRow.filingDate !== record.filingDate
    || oldRow.finalActionRaw !== record.finalActionRaw
    || oldRow.filingRaw !== record.filingRaw
    || oldRow.sourceUrl !== record.sourceUrl
}

/** 抓取 -> 差异写库 -> 用全量历史预测 -> 写库 */
export async function runScrape({ month, dryRun = false } = {}) {
  const monthIso = month ? `${month.slice(0, 7)}-01` : undefined
  const { records, errors } = await scrape({ monthIso })
  const existing = dryRun ? [] : await readBulletins()
  const byMonth = new Map(existing.map((row) => [row.month, row]))

  let writtenCount = 0
  if (!dryRun) {
    for (const record of records) {
      const oldRow = byMonth.get(record.month)
      if (!oldRow || changed(oldRow, record)) {
        await writeBulletin(record)
        writtenCount += 1
      }
    }
  }

  const stored = dryRun ? records : await readBulletins()
  const prediction = predictNext(stored)
  if (!dryRun) await writePrediction(prediction)

  return {
    ok: true,
    dryRun,
    scrapedCount: records.length,
    writtenCount,
    warnings: errors,
    latest: records[records.length - 1],
    prediction,
  }
}

/** 每月 11 日起每天 20:00 检查当月新数据；发现后停止请求，直到下月 11 日 */
const scheduleState = {
  lastCheckAt: null,
  lastResult: null,
  completedMonth: null,
}

async function scheduledCheck(now = new Date()) {
  const currentMonth = monthKey(now)
  scheduleState.lastCheckAt = now.toISOString()

  if (now.getDate() < 11) {
    scheduleState.lastResult = 'skip-before-11th'
    console.log(`[cron] ${currentMonth} 未到 11 日，跳过检查`)
    return
  }

  try {
    const before = await readBulletins()
    if (hasMonth(before, currentMonth) || scheduleState.completedMonth === currentMonth) {
      scheduleState.completedMonth = currentMonth
      scheduleState.lastResult = 'already-published'
      console.log(`[cron] ${currentMonth} 数据已存在，不再请求`)
      return
    }

    console.log(`[cron] ${currentMonth} 尚未发布，开始检查新数据…`)
    const result = await runScrape()
    const after = await readBulletins()
    if (hasMonth(after, currentMonth)) {
      scheduleState.completedMonth = currentMonth
      scheduleState.lastResult = 'published-and-saved'
      console.log(`[cron] 已发现并保存 ${currentMonth} 新数据，停止请求至下月 11 日`)
    } else {
      scheduleState.lastResult = 'not-published-yet'
      console.log(`[cron] ${currentMonth} 仍无新数据，明晚 20:00 继续检查`)
    }
  } catch (error) {
    scheduleState.lastResult = `error: ${error.message}`
    console.error('[cron] 自动检查失败：', error.message)
  }
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'eb2-visa-tracker', time: new Date().toISOString() })
})

app.get('/api/schedule', (_req, res) => {
  const now = new Date()
  res.json({
    ok: true,
    rule: '每月 11 日至月底每天 20:00 检查当月新数据；发现后停止请求至下月 11 日',
    currentMonth: monthKey(now),
    completedMonth: scheduleState.completedMonth,
    lastCheckAt: scheduleState.lastCheckAt,
    lastResult: scheduleState.lastResult,
  })
})

app.get('/api/data', asyncRoute(async (_req, res) => {
  const [bulletins, prediction] = await Promise.all([readBulletins(), readLatestPrediction()])
  res.json({
    ok: true,
    bulletins,
    prediction: prediction
      ? {
          targetMonth: String(prediction.target_month).slice(0, 10),
          finalActionDate: prediction.predicted_final_action_date
            ? String(prediction.predicted_final_action_date).slice(0, 10)
            : null,
          filingDate: prediction.predicted_filing_date
            ? String(prediction.predicted_filing_date).slice(0, 10)
            : null,
          method: prediction.method,
          basis: prediction.basis,
          stats: prediction.stats ?? null,
          basedOnMonth: prediction.basis?.[prediction.basis.length - 1]?.month ?? null,
          generatedAt: prediction.created_at,
        }
      : null,
  })
}))

app.post('/api/scrape', asyncRoute(async (req, res) => {
  const result = await runScrape({
    month: req.body?.month,
    dryRun: Boolean(req.body?.dryRun),
  })
  res.json(result)
}))

app.post('/api/schedule/check', asyncRoute(async (req, res) => {
  // 可选 month 参数仅用于手动模拟某个月的检查逻辑
  const month = req.body?.month
  const dayPart = /^\d{4}-\d{2}-\d{2}$/.test(month ?? '') ? month.slice(0, 10) : `${month?.slice(0, 7) ?? ''}-15`
  const now = month ? new Date(`${dayPart}T20:00:00`) : new Date()
  await scheduledCheck(now)
  res.json({ ok: true, ...scheduleState })
}))

app.use(express.static(rootDir))
app.get('*', (_req, res) => res.sendFile(path.join(rootDir, 'index.html')))

const port = Number(process.env.PORT ?? 3001)
app.listen(port, () => {
  console.log(`EB-2 排期服务已启动：http://localhost:${port}`)
  console.log('定时任务：每月 11 日至月底每天 20:00 条件检查（发现当月新数据后停止请求）')
})

cron.schedule('0 20 * * *', scheduledCheck)
