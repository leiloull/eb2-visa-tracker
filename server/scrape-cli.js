import 'dotenv/config'
import { scrape } from './scraper.js'
import { readBulletins, writeBulletin, writePrediction } from './cloud.js'
import { predictNext } from './predictor.js'

const args = process.argv.slice(2)
const monthIndex = args.indexOf('--month')
const month = monthIndex >= 0 && args[monthIndex + 1] ? args[monthIndex + 1] : undefined
const dryRun = args.includes('--dry-run')

async function main() {
  const { records, errors } = await scrape({ monthIso: month ? `${month.slice(0, 7)}-01` : undefined })
  console.log(`抓取到 ${records.length} 条记录`)

  if (!dryRun) {
    for (const record of records) {
      await writeBulletin(record)
    }
    console.log('已写入云数据库')
  }

  const bulletins = dryRun ? records : await readBulletins()
  const prediction = predictNext(bulletins)
  if (!dryRun) {
    await writePrediction(prediction)
  }

  console.log(JSON.stringify({ errors, prediction }, null, 2))
}

main().catch((error) => {
  console.error('抓取失败：', error)
  process.exitCode = 1
})
