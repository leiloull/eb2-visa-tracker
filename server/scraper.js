import * as cheerio from 'cheerio'

const PRIMARY_URL = 'https://visanow.info/zh/visa-bulletin/eb2-china-visa-bulletin'
const HISTORY_URL = 'https://litigationscope.com/visa-bulletin/history/eb-2/china-mainland-born'
const OFFICIAL_BASE = 'https://travel.state.gov/content/travel/en/legal/visa-law0/visa-bulletin'
const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
]
const MONTH_INDEX = Object.fromEntries(MONTH_NAMES.map((name, index) => [name, index + 1]))
const MONTH_ABBR = {
  JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
  JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
}
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const pad = (n) => String(n).padStart(2, '0')

/** 构造美国国务院官方月度公告 URL（财年目录） */
export function buildOfficialUrl(year, month) {
  const fiscalYear = month >= 10 ? year + 1 : year
  return `${OFFICIAL_BASE}/${fiscalYear}/visa-bulletin-for-${MONTH_NAMES[month - 1]}-${year}.html`
}

/** 解析中文日期：2021年10月1日 -> 2021-10-01 */
export function parseChineseDate(raw) {
  const text = String(raw ?? '').trim()
  if (/current|当前|无限制/i.test(text)) return 'CURRENT'
  if (/unavailable|不可用|无数据|^u$/i.test(text)) return 'UNAVAILABLE'
  const m = text.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/)
  if (!m) return null
  return `${m[1]}-${pad(m[2])}-${pad(m[3])}`
}

/** 解析官方代码：01OCT21 -> 2021-10-01 */
export function parseOfficialCode(raw) {
  const text = String(raw ?? '').replace(/\s+/g, '').toUpperCase()
  if (text === 'C') return 'CURRENT'
  if (text === 'U') return 'UNAVAILABLE'
  const m = text.match(/^(\d{2})([A-Z]{3})(\d{2})$/)
  if (!m || !MONTH_ABBR[m[2]]) return null
  return `20${m[3]}-${MONTH_ABBR[m[2]]}-${m[1]}`
}

function parseMonth(raw) {
  const m = String(raw ?? '').match(/(\d{4})\s*年\s*(\d{1,2})\s*月/)
  return m ? `${m[1]}-${pad(m[2])}-01` : null
}

/** 解析英文月份：October 2021 -> 2021-10-01 */
function parseEnglishMonth(raw) {
  const text = String(raw ?? '').trim()
  const m = text.match(/^([A-Za-z]+)\s+(\d{4})$/)
  if (!m || !MONTH_INDEX[m[1].toLowerCase()]) return null
  return `${m[2]}-${pad(MONTH_INDEX[m[1].toLowerCase()])}-01`
}

async function fetchText(url, timeout = 20000) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(timeout),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
  return res.text()
}

/**
 * 主数据源：visanow.info 的 EB-2 中国大陆排期页。
 * 该页以 table.landing-table 直接列出最近 12 个月的表 A / 表 B，且附有 DOS 官方来源链接。
 */
export async function scrapePrimary() {
  const html = await fetchText(PRIMARY_URL)
  const $ = cheerio.load(html)
  const records = []

  $('table.landing-table tbody tr').each((_, tr) => {
    const cells = $(tr).find('td').map((__, td) => $(td).text().replace(/\s+/g, ' ').trim()).get()
    if (cells.length < 4) return
    const month = parseMonth(cells[0])
    if (!month) return
    const finalActionDate = parseChineseDate(cells[1])
    const filingDate = parseChineseDate(cells[3])
    if (!finalActionDate && !filingDate) return
    records.push({
      month,
      finalActionDate,
      finalActionRaw: cells[1],
      filingDate,
      filingRaw: cells[3],
      sourceUrl: '',
      sourceName: 'visanow.info（整理自 DOS Visa Bulletin）',
      note: '自动抓取',
    })
  })

  if (!records.length) throw new Error('主数据源未解析到任何排期记录')

  let officialUrl = ''
  $('a[href*="travel.state.gov"][href*="visa-bulletin-for-"]').each((_, a) => {
    if (!officialUrl) officialUrl = $(a).attr('href') ?? ''
  })

  for (const record of records) {
    const [y, m] = record.month.split('-')
    record.sourceUrl = officialUrl || buildOfficialUrl(Number(y), Number(m))
  }

  return records.sort((a, b) => a.month.localeCompare(b.month))
}

/**
 * 官方源（尽力而为）：travel.state.gov 有 Cloudflare 防护，抓取失败时自动回退到主数据源。
 */
export async function scrapeOfficial(monthIso) {
  const [year, month] = monthIso.split('-').map(Number)
  const url = buildOfficialUrl(year, month)
  const html = await fetchText(url, 15000)
  const $ = cheerio.load(html)

  // 就业类表格特征：含 CHINA 与 Other Workers，页面上恰好两张（最终裁定日 / 递交申请日）
  const employmentTables = $('table').toArray().filter((table) => {
    const text = $(table).text()
    return /CHINA/i.test(text) && /Other Workers/i.test(text)
  })
  if (employmentTables.length < 2) throw new Error('官方页面结构变化，未找到就业类表格')

  function extractChinaDate(table) {
    const rows = $(table).find('tr').toArray()
    const header = rows.length
      ? $(rows[0]).find('th,td').map((_, el) => $(el).text().replace(/\s+/g, ' ').trim()).get()
      : []
    let chinaIndex = header.findIndex((h) => /CHINA/i.test(h) && /mainland/i.test(h))
    if (chinaIndex < 0) chinaIndex = 2

    for (const row of rows) {
      const cells = $(row).find('th,td').map((_, el) => $(el).text().replace(/\s+/g, ' ').trim()).get()
      if (cells.length && /^2nd\b/i.test(cells[0])) {
        return parseOfficialCode(cells[chinaIndex])
      }
    }
    return null
  }

  const finalActionDate = extractChinaDate(employmentTables[0])
  const filingDate = extractChinaDate(employmentTables[1])
  if (!finalActionDate && !filingDate) throw new Error('官方页面未解析到 EB-2 中国排期')

  return {
    month: monthIso,
    finalActionDate,
    finalActionRaw: finalActionDate,
    filingDate,
    filingRaw: filingDate,
    sourceUrl: url,
    sourceName: 'DOS Visa Bulletin（官方）',
    note: '官方页面直接抓取',
  }
}

/**
 * 历史数据源：litigationscope 按 DOS 官方公告整理的逐月表 A / 表 B，
 * 页面内含近 5 年（60 期）数据，并附每期官方 bulletin 链接。
 */
export async function scrapeHistory({ limit = 60 } = {}) {
  const html = await fetchText(HISTORY_URL, 25000)
  const $ = cheerio.load(html)
  const tables = $('table.data-table').toArray()

  function parseTable(table) {
    const result = new Map()
    $(table).find('tbody tr').each((_, tr) => {
      const cells = $(tr).find('td').map((__, td) => $(td).text().replace(/\s+/g, ' ').trim()).get()
      if (cells.length < 2) return
      const month = parseEnglishMonth(cells[0])
      if (!month) return
      const date = parseOfficialCode(cells[1])
      if (!date) return
      const sourceUrl = $(tr).find('a').first().attr('href') ?? ''
      result.set(month, { date, raw: cells[1], sourceUrl })
    })
    return result
  }

  const finalAction = parseTable(tables.find((t) => /Final Action Dates/i.test($(t).find('caption').text())) ?? tables[0])
  const filing = parseTable(tables.find((t) => /Dates for Filing/i.test($(t).find('caption').text())) ?? tables[1])
  if (!finalAction.size || !filing.size) throw new Error('历史数据源未解析到有效表格')

  const months = [...new Set([...finalAction.keys(), ...filing.keys()])].sort()
  const records = months.slice(-limit).map((month) => ({
    month,
    finalActionDate: finalAction.get(month)?.date ?? null,
    finalActionRaw: finalAction.get(month)?.raw ?? null,
    filingDate: filing.get(month)?.date ?? null,
    filingRaw: filing.get(month)?.raw ?? null,
    sourceUrl: finalAction.get(month)?.sourceUrl || filing.get(month)?.sourceUrl || '',
    sourceName: 'litigationscope（整理自 DOS Visa Bulletin）',
    note: '历史数据',
  }))

  return records
}

/** 统一抓取入口：历史 5 年数据 + 最近 12 个月镜像（后者覆盖前者，保证最新月准确） */
export async function scrape({ monthIso } = {}) {
  const errors = []
  const byMonth = new Map()

  try {
    for (const record of await scrapeHistory()) {
      byMonth.set(record.month, record)
    }
  } catch (error) {
    errors.push(`历史源：${error.message}`)
  }

  let recent = []
  if (monthIso) {
    try {
      recent = [await scrapeOfficial(monthIso)]
    } catch (error) {
      errors.push(`官方源：${error.message}`)
    }
  }
  if (!recent.length) {
    try {
      recent = await scrapePrimary()
    } catch (error) {
      errors.push(`近期源：${error.message}`)
    }
  }

  for (const record of recent) {
    byMonth.set(record.month, record)
  }

  const records = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month))
  if (!records.length) throw new Error(`抓取失败（${errors.join('；')}）`)

  return { records, errors }
}
