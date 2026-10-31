# ValoArchive-Open-Web

ValoArchive 的**面向客户前端**：只做查询与分享，不含任何管理入口（登录态、凭据、授权后台都不在这里）。

它和 `ValoArchive-Web` **共用一个后端**——`ValoArchive-Web` 那边的 API（默认 `127.0.0.1:8765`）。本仓库是纯静态文件，任何静态托管（Nginx、OSS、Vercel、GitHub Pages…）都能放。

## 部署三步

1. **配后端地址**：编辑 `config.js`
   ```js
   window.VALO_CONFIG = {
     apiBase: "https://api.example.com",   // 同源部署就留空
     apiKey: ""                            // 留空 = 访客自己输口令（推荐）
   };
   ```
2. **上传**：把整个目录传到静态托管根目录（保持 `index.html` 在最外层）。
3. **访问**：`https://你的域名/`。准星、点位分享分别是 `/crosshair.html`、`/lineups.html`。

> 后端已开 CORS（`allow_origins=["*"]`），跨域直接可用。

## 门禁：只有拿到口令的人能进来

`apiKey` 留空时，页面就是「要口令才进」的模式：

1. 打开页面先问后端 `/api/gate/verify`；
2. 口令不对 / 没带 → 一张盖住全屏的登录框，此时**一个业务请求都不会发出去**；
3. 口令正确 → 存进 `localStorage`（`va.gate.v1`），刷新也不用再输，地址栏里的 `?key=` 会被立刻抹掉。

口令由后端签发，到期自动失效、可随时吊销（吊销后下一次请求就进不来）：

```bash
cd ValoArchive-Web
python scripts/key.py new --days 7 --label "给室友"   # 签一把 7 天的
python scripts/key.py list                            # 看谁还有效
python scripts/key.py rm 30b773c5                     # 吊销
```

口令全程走 `X-Access-Key` 请求头（图片走 `?key=`），不进静态文件、不留在分享链接里。
`config.js` 里的 `apiKey` 只适合「自己人内部用一份固定口令」的场景——它随文件公开。

> 注意：被挡住的是**数据**。HTML/CSS/JS 本身仍是公开静态文件，谁都能下载，但拿不到任何战绩。

## 本地缓存

所有 `GET /api/*` 的 JSON 会落进浏览器 IndexedDB（`valoarchive-cache`），断网时用旧数据兜底
（响应头 `X-Local-Cache: HIT / STALE`）。有效期按数据类型分：单局详情 30 天，资产/赛季/资料库
1 天，玩家资料与历史 10 分钟，健康检查不缓存。想强制拿新的：链接后加 `?nocache=1`，
或在控制台跑 `await valoCacheClear()`。

## 有什么

- 玩家概览、历史战绩（含模式/队伍筛选、日期区间、导出）、单局详情、赛季、资产、好友与组队
- 中文 ID 免 `#`、掌瓦号查询、固定 ID 复制、单局内点人名直接查
- 准星代码分享、点位分享（内容全在链接里，不落库）
- 最近查询 / 收藏（只存在浏览器 localStorage）

## 没有什么（刻意去掉）

- 登录态扫码、凭据查看、授权后台、订阅管理、导出后台
- 任何 `/valoadmin`、`/login`、`/admin` 入口

## 免责

非官方社区工具，与 Riot Games / 腾讯无关。数据来自公开战绩，仅供参考；如涉及隐私请联系站点管理员删除。
