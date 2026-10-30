# ValoArchive-Open-Web

ValoArchive 的**面向客户前端**：只做查询与分享，不含任何管理入口（登录态、凭据、授权后台都不在这里）。

它和 `ValoArchive-Web` **共用一个后端**——`ValoArchive-Web` 那边的 API（默认 `127.0.0.1:8765`）。本仓库是纯静态文件，任何静态托管（Nginx、OSS、Vercel、GitHub Pages…）都能放。

## 部署三步

1. **配后端地址**：编辑 `config.js`
   ```js
   window.VALO_CONFIG = {
     apiBase: "https://api.example.com",   // 同源部署就留空
     apiKey: "你的后端口令"                  // 后端没开口令就留空
   };
   ```
2. **上传**：把整个目录传到静态托管根目录（保持 `index.html` 在最外层）。
3. **访问**：`https://你的域名/`。准星、点位分享分别是 `/crosshair.html`、`/lineups.html`。

> 后端已开 CORS（`allow_origins=["*"]`），跨域直接可用。口令放在 `config.js` 里会随文件公开——想要“只有自家前端能用”，请在后端反代层按 Referer/Origin 或独立 key 做限制。

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
