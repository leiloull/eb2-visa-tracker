// 将网页端静态资源同步到 www/，供 Capacitor 打包进 App。
// App 通过云端 REST 读取实时数据，因此这里只需要静态三件套。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const files = ['index.html', 'styles.css', 'app.js']
const www = path.join(root, 'www')

fs.mkdirSync(www, { recursive: true })
for (const file of files) {
  const src = path.join(root, file)
  const dst = path.join(www, file)
  fs.copyFileSync(src, dst)
  console.log(`synced ${file} -> www/${file}`)
}

// 移除 www 中不存在的旧文件（保留目录本身）
for (const entry of fs.readdirSync(www)) {
  if (!files.includes(entry)) {
    const target = path.join(www, entry)
    if (fs.statSync(target).isFile()) fs.unlinkSync(target)
  }
}
console.log('www/ is ready for Capacitor')
