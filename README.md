# EB-2 中国大陆绿卡排期追踪与预测

一个可直接运行的全栈项目：**Node.js 后端 + WorkBuddy 云数据库 + 原生前端**，并可用 **Capacitor 封装为 iOS / Android App**（Codemagic 云端出包）。

- 自动抓取并保存最近 **5 年（60+ 期）** EB-2（中国大陆出生）的表 A / 表 B 排期
- 基于**全量历史数据**做线性回归，预测下一期排期
- 数据持久化在云数据库；网页端经后端 REST API 读取，**App 内直连云数据库只读接口**（无需本地后端）
- 每月 **11 日至月底每天 20:00** 检查当月新数据；发现后停止请求，直到下月 11 日
- 也可手动点击前端「刷新数据」或使用命令行抓取

## 目录结构

```
.
├── index.html            # 前端页面
├── styles.css            # 前端样式
├── app.js                # 前端逻辑（走势图 / 表格 / 交互）
├── server/
│   ├── index.js          # Express 服务、REST API、条件定时任务
│   ├── scraper.js        # 五年历史 + 近期数据抓取与解析
│   ├── predictor.js      # 全期趋势预测算法
│   ├── cloud.js          # 云数据库客户端与读写封装
│   └── scrape-cli.js     # 命令行抓取工具
├── scripts/sync-web.mjs  # 把前端三件套同步到 www/
├── www/                  # Capacitor 打包用的静态资源（自动生成）
├── android/              # Android 原生工程（Capacitor 生成）
├── ios/                  # iOS 原生工程（Capacitor 生成）
├── capacitor.config.json # App ID / 名称 / webDir 配置
├── codemagic.yaml        # Codemagic 云端构建工作流
├── .env                  # 云服务 publicConfig 与写入令牌（本地）
└── .env.example
```

## 本地运行

```bash
npm install
npm start
```

打开 <http://localhost:3001>。

> `.env` 已按当前应用配置填好。若换环境，请复制 `.env.example` 并填入云服务的 `CLOUD_ENDPOINT` / `CLOUD_PUBLISHABLE_KEY` / `WRITE_TOKEN`。

手动抓取：

```bash
npm run scrape                # 抓取近 5 年全量数据并写库（仅新/变更月份才写）
npm run scrape -- --dry-run   # 只抓取预览，不写库
npm run scrape -- --month 2026-10
```

## 数据源

1. **历史 5 年**：`litigationscope.com` 按 DOS 公告整理的逐月表 A / 表 B（含每期官方 bulletin 链接）
2. **近期数据**：`visanow.info` 的 EB-2 中国大陆排期页（最近 12 个月，用于覆盖/校正历史源）
3. **官方源**：美国国务院 [Visa Bulletin](https://travel.state.gov/content/travel/en/legal/visa-law0/visa-bulletin.html)；因 Cloudflare 防护，作为尽力而为的优先尝试，失败自动回退

抓取字段：
- `final_action_date`：表 A / Final Action Date（最终裁定日）
- `filing_date`：表 B / Dates for Filing（递交申请日）

当前数据库覆盖 **2021-10 至 2026-11，共 62 期**。

## 预测方法

`server/predictor.js` 使用**最近 5 年（60 期）全部有效日期点**：

1. 以月份序号为自变量、优先日期时间戳为因变量，做一元线性回归，得到「每月平均推进天数」
2. 将趋势值限制在 `0 ~ 180 天/月`，避免异常值造成荒谬外推
3. 用最新一期日期 + 趋势天数，并吸附到 DOS 常用的 1 / 8 / 15 / 22 日
4. `C` / `U` 等非日期值不参与回归，沿用上期状态
5. 预测记录保存样本数、净推进、月均值、回归斜率与依据月份

当前预测（2026-12）：表 A `2021-10-22`，表 B `2023-01-22`；全期趋势分别约 18.6 / 21.6 天每月。

## 条件定时刷新

`node-cron` 表达式：`0 20 * * *`（每天 20:00）:

- 若当前日期 `< 11 日`：直接跳过，不发起任何请求
- 若数据库中已有**当月**数据：标记 `completedMonth`，不再请求，直到月份变化
- 若当月数据尚未发布：发起抓取；发现并写入新数据后，后续每天不再请求；未发现则次日 20:00 继续检查

可通过 `GET /api/schedule` 查看规则与状态；`POST /api/schedule/check` 可手动触发一次检查（可选 body `{ "month": "2026-12-15" }` 用于模拟指定日期）。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| GET | `/api/data` | 读取全部历史排期与最新预测（含趋势统计） |
| POST | `/api/scrape` | 抓取、差异写库并更新预测；body 可传 `{ "month": "2026-10", "dryRun": false }` |
| GET | `/api/schedule` | 查看条件刷新规则与运行状态 |
| POST | `/api/schedule/check` | 手动触发一次条件检查 |

## 数据库

云数据库表：

- `eb2_bulletin`：月份主键、表 A/B 日期与原始文本、来源链接、抓取时间
- `eb2_prediction`：目标月份主键、预测日期、方法说明、依据 JSON、趋势统计 JSON

安全模型：表开启 RLS，前端角色仅 `SELECT`；写入通过 `SECURITY DEFINER` 函数 `upsert_eb2_bulletin` / `upsert_eb2_prediction_with_stats` 完成，并校验 `WRITE_TOKEN`。

## 封装为 iOS / Android App

本项目用 **Capacitor 8** 把现有网页封装为原生 App，原生工程已生成在 `android/` 和 `ios/`。

**工作原理**：App 内的网页通过云服务的公开只读接口（`x-wb-webapp-access-key` + publishable key，仅 `SELECT` 权限）直接读取云数据库，**不依赖本地 Node 后端**。抓取与预测仍由你本地/服务器上的后端定时任务负责写库。App 内的按钮为「刷新数据」（只读），不会触发抓取。

> 安全说明：下发到 App 的只有 publishable key（只读）；写入令牌 `WRITE_TOKEN` 只存在于后端 `.env`，从不进入 App 包。

应用标识：`com.workbuddy.eb2tracker`，名称：`EB2排期追踪`。

### 前端改动后同步到 App

```bash
npm run cap:sync       # 同步前端三件套到 www/ 并复制进原生工程
```

### 本地预览

```bash
npm run build:android  # 需本机安装 JDK 17 + Android SDK（当前机器未安装）
npm run open:android   # 用 Android Studio 打开，连接设备/模拟器运行
npm run open:ios       # 需 macOS + Xcode + CocoaPods
```

当前 Windows 环境**没有 JDK / Android SDK / Xcode**，无法在本机编译出安装包，请使用下面的云端构建。

### Codemagic 云端出包（推荐）

代码仓库：<https://github.com/leiloull/eb2-visa-tracker>。`codemagic.yaml` 已在仓库根目录，Codemagic 会自动识别。

#### 第 1 步：添加应用

1. 用 GitHub 账号登录 [Codemagic](https://codemagic.io/)，点 **Add application**。
2. 选择 GitHub，授权后选中仓库 `leiloull/eb2-visa-tracker`。
3. 项目类型下拉里若有 **Ionic / Ionic Capacitor** 就选它；没有就直接选 **Other**（构建完全由 `codemagic.yaml` 驱动，这里选什么都不影响结果），点 Finish。
4. 进入应用后，在顶部 **Configuration** 处选择分支 `main`，点 **Check for configuration file**，让 Codemagic 读取 `codemagic.yaml`。确认能列出三个工作流（见下）。

#### 第 2 步：创建环境变量组（仅正式签名包需要）

`android-debug` 是零凭据工作流，**无需创建任何环境变量组**。只有要打正式签名包时，才在应用设置（或团队设置）里创建环境变量组 **`eb2-app-credentials`**：

| 变量 | 用途 | 必填 |
|---|---|---|
| `ANDROID_KEYSTORE_FILE` | keystore 文件的 base64 文本 | 仅 release |
| `ANDROID_KEYSTORE_PASSWORD` | keystore 密码 | 仅 release |
| `ANDROID_KEY_ALIAS` | 密钥别名 | 仅 release |
| `ANDROID_KEY_PASSWORD` | 密钥密码 | 仅 release |

> 注意：配置里没有启用邮件通知（避免未设置邮箱变量时构建校验失败）。构建产物到构建详情页的 **Artifacts** 标签下载。

#### 第 3 步：运行构建

在 Codemagic 应用页右上角点 **Start new build**，选择工作流：

- **`android-debug`** ← 先跑这个。macOS M2 构建机，无需签名、无需任何环境变量，产出可安装的 **debug APK**。构建成功后点进该次构建，在 **Artifacts** 标签下载 APK，传到安卓手机即可安装（需允许安装未知来源应用）。
  - 说明：三个工作流统一用 `mac_mini_m2` 实例，因为 Codemagic 免费个人计划每月有 500 分钟 M2 免费额度；`linux_x2` 等 Linux 实例需开启付费 billing 才能使用。Android 构建在 macOS 上完全可行。
- **`android-release`**：配好 4 个签名变量后运行，产出签名 **APK + AAB**（AAB 用于上架 Google Play）。
- **`ios-app-store`**：macOS 构建机，产出 **IPA**。需先完成下面的 iOS 签名配置。

#### iOS 签名配置（仅 iOS 需要）

1. 需要付费的 **Apple Developer Program** 账号。
2. 在 App Store Connect 用 Bundle ID `com.workbuddy.eb2tracker` 创建一个 App 记录（用于接收构建）。
3. 在 Codemagic 创建 App Store Connect API 密钥（Users and Access → Integrations → App Store Connect API，角色 App Manager），下载 `.p8` 密钥、记下 Issuer ID / Key ID。
4. 在 Codemagic 的 **Team integrations → Developer Portal** 连接该 API 密钥，并把 Apple Distribution 证书与 App Store provisioning profile 加入代码签名身份（Codemagic 会自动匹配 `com.workbuddy.eb2tracker`）。
5. `codemagic.yaml` 的 `ios-app-store` 工作流已配置 `ios_signing` + `xcode-project use-profiles`，会自动完成签名。

#### 生成 Android 签名 keystore（仅 release 需要）

本地执行一次（需 JDK 的 `keytool`），生成后把文件转成 base64 填入 `ANDROID_KEYSTORE_FILE`：

```bash
keytool -genkeypair -v -storetype PKCS12 -keystore eb2-release.keystore \
  -alias eb2 -keyalg RSA -keysize 2048 -validity 10000
# macOS: base64 -i eb2-release.keystore | pbcopy
# Linux/Git Bash: base64 -w0 eb2-release.keystore
```

> **务必自行保管 keystore 文件**：丢失后无法用同一签名更新应用。它已被 `.gitignore` 排除，不会进仓库。

上传 App Store / Google Play 前，请自行完成各平台的开发者账号、隐私政策与审核配置；本项目不含这些账号凭据。

## 免责声明

预测为基于历史数据的统计外推，不代表美国国务院或 USCIS 的官方决定，不构成法律意见。表 B 是否可用于递交 I-485 需以 USCIS 当月公告为准。
