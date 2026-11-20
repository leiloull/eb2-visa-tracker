import 'dotenv/config'
import { createWorkBuddyCloud } from '@tencent-ai/workbuddy-cloud-sdk'

const endpoint = process.env.CLOUD_ENDPOINT
const publishableKey = process.env.CLOUD_PUBLISHABLE_KEY

if (!endpoint || !publishableKey) {
  throw new Error('缺少 CLOUD_ENDPOINT / CLOUD_PUBLISHABLE_KEY，请复制 .env.example 为 .env 并填入 publicConfig')
}

// 全应用只初始化一次客户端，所有模块共享
export const cloud = createWorkBuddyCloud({
  endpoint,
  publishableKey,
})

export const WRITE_TOKEN = process.env.WRITE_TOKEN

function unwrap({ data, error }) {
  if (error) throw error
  return data
}

/** 读取全部历史排期（升序） */
export async function readBulletins() {
  const rows = await unwrap(
    await cloud.database.from('eb2_bulletin').select('*').order('month', { ascending: true })
  )
  return (rows ?? []).map(normalizeBulletin)
}

/** 读取最新一条预测 */
export async function readLatestPrediction() {
  const rows = await unwrap(
    await cloud.database
      .from('eb2_prediction')
      .select('*')
      .order('target_month', { ascending: false })
      .limit(1)
  )
  return rows?.[0] ?? null
}

/** 通过 SECURITY DEFINER 函数写入排期（前端无写权限） */
export async function writeBulletin(record) {
  await cloud.database.rpc('upsert_eb2_bulletin', {
    p_month: record.month,
    p_final_action_raw: record.finalActionRaw ?? null,
    p_final_action_date: record.finalActionDate ?? null,
    p_filing_raw: record.filingRaw ?? null,
    p_filing_date: record.filingDate ?? null,
    p_source_url: record.sourceUrl,
    p_source_name: record.sourceName ?? 'DOS Visa Bulletin',
    p_note: record.note ?? null,
    p_token: WRITE_TOKEN,
  })
}

/** 写入预测结果 */
export async function writePrediction(prediction) {
  await cloud.database.rpc('upsert_eb2_prediction_with_stats', {
    p_target_month: prediction.targetMonth,
    p_final_action_date: prediction.finalActionDate ?? null,
    p_filing_date: prediction.filingDate ?? null,
    p_method: prediction.method,
    p_basis: prediction.basis ?? [],
    p_stats: prediction.stats ?? {},
    p_token: WRITE_TOKEN,
  })
}

function normalizeBulletin(row) {
  return {
    month: isoDate(row.month),
    finalActionDate: isoDate(row.final_action_date),
    finalActionRaw: row.final_action_raw,
    filingDate: isoDate(row.filing_date),
    filingRaw: row.filing_raw,
    sourceUrl: row.source_url,
    sourceName: row.source_name,
    scrapedAt: row.scraped_at,
    note: row.note,
  }
}

export function isoDate(value) {
  if (!value) return null
  return String(value).slice(0, 10)
}
