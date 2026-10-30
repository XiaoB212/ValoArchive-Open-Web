/* ValoArchive-Web 前端：无构建、无框架，只做三件事——取数、切片、画。 */

// 远端图一律走 /img 代理（上游会校验 Referer）；本站路径（/static/*.svg 这类）
// 必须直连 —— 送进代理会 400，浏览器就画成「图片坏了」。
const img = (url) => (!url ? "" : (String(url).startsWith("/") ? String(url) : `/img?url=${encodeURIComponent(url)}`));

// 老版本的「最近查询」存在 localStorage（valoarchive.recent.v1），UI 已经去掉了，顺手清干净。
try {
  localStorage.removeItem("valoarchive.recent.v1");
} catch (err) {
  /* 隐私模式下 localStorage 会抛异常，忽略即可 */
}

const state = {
  keyword: "",
  player: null,
  page: 1,
  size: 20,
  // 默认按「获取时间」新→旧：用户要的是先看最近拿到的皮肤，而不是按枪型分类。
  assetSort: "unlock",
  assetOrder: "desc",
  source: "game",
  filter: "all",
  // 对局历史的「查看模式」：按模式分类过滤（服务端按 names.mode_group 归组）
  gm: (() => {
    try { return localStorage.getItem("valo.gm") || "all"; } catch (_) { return "all"; }
  })(),
  total: 0,
  rows: [],
  matchId: null,
  matchLoaded: false,
  tab: "history",
  socialGroup: "all",
  seasonData: null,
};

const $ = (sel) => document.querySelector(sel);
const _QUERY = new URLSearchParams(location.search);
const EXPORT_KIND = _QUERY.get("export");
const EXPORT_PAGE = Math.max(1, Number(_QUERY.get("page")) || 1);
const EXPORT_SIZE = Math.max(1, Number(_QUERY.get("size")) || 20);
const EXPORT_FILTER = _QUERY.get("filter") === "party" ? "party" : "all";
const EXPORT_SORT = _QUERY.get("sort") || "";
// 导出「近五场单局」时，一次只渲一场：第 N 张图就是第 N 场
const EXPORT_MATCH = Math.max(0, Number(_QUERY.get("match")) || 0);

// ── 隐私模式（privacy=1）──────────────────────────────────────────
// 导出/分享时把玩家名遮成「玩家A/玩家B」，并隐藏掌瓦号与固定 ID。
// 后端把 privacy=1 带进导出页面 URL，页面自己遮——这样 PDF / PNG / 网页
// 三种出口走的是同一套遮罩，不会漏。
const PRIVACY = _QUERY.get("privacy") === "1";
const PRIVACY_ALIAS = new Map();
const _privateAlias = (i) => (i < 26
  ? `玩家${String.fromCharCode(65 + i)}`
  : `玩家${String.fromCharCode(65 + (i % 26))}${Math.floor(i / 26) + 1}`);

const _maskText = (text) => text.replace(/[^\s#<>|，,。()（）\[\]【】]{1,18}#\d{2,6}/g, (hit) => {
  if (!PRIVACY_ALIAS.has(hit)) PRIVACY_ALIAS.set(hit, _privateAlias(PRIVACY_ALIAS.size));
  return PRIVACY_ALIAS.get(hit);
});

let _masking = false;
const applyPrivacy = () => {
  if (!PRIVACY || _masking) return;
  _masking = true;
  try {
    document.body.classList.add("privacy-mode");
    if (document.title) document.title = _maskText(document.title);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    const nodes = [];
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeValue && node.nodeValue.includes("#")) nodes.push(node);
    }
    nodes.forEach((item) => {
      const next = _maskText(item.nodeValue);
      if (next !== item.nodeValue) item.nodeValue = next;
    });
  } finally {
    _masking = false;
  }
};

if (PRIVACY) {
  const start = () => {
    applyPrivacy();
    // 渲染是异步的（先骨架、后数据），所以盯着 DOM 变化再遮一次；
    // 自己写回文本也会触发一次，靠 _masking 防重入。
    new MutationObserver(applyPrivacy).observe(document.body, {
      subtree: true, childList: true, characterData: true,
    });
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
}
const EXPORT_ORDER = _QUERY.get("order") || "";
// 导出页的日期区间（YYYY-MM-DD），由导出弹窗传进来；只影响导出渲染那一屏
const EXPORT_DATE_FROM = _QUERY.get("from") || "";
const EXPORT_DATE_TO = _QUERY.get("to") || "";
const $$ = (sel) => [...document.querySelectorAll(sel)];

const api = {
  async get(path, params = {}) {
    const url = new URL(path, location.origin);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url);
    if (!res.ok) {
      let detail = res.statusText;
      try {
        detail = (await res.json()).detail || detail;
      } catch (_) { /* keep statusText */ }
      const err = new Error(
        typeof detail === "string" ? detail : (detail.message || res.statusText)
      );
      err.status = res.status;
      err.detail = detail;
      throw err;
    }
    return res.json();
  },
  async post(path, body = null) {
    const res = await fetch(new URL(path, location.origin), {
      method: "POST",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      let detail = res.statusText;
      try {
        detail = (await res.json()).detail || detail;
      } catch (_) { /* keep statusText */ }
      throw new Error(detail);
    }
    return res.json();
  },
};


let busyDepth = 0;

function setBusy(on, text) {
  busyDepth = Math.max(0, busyDepth + (on ? 1 : -1));
  const bar = document.querySelector("#loadbar");
  const chip = $("#busy");
  if (bar) bar.classList.toggle("on", busyDepth > 0);
  if (chip) {
    chip.classList.toggle("hidden", busyDepth === 0);
    if (busyDepth > 0 && text) $("#busy-text").textContent = text;
  }
  const btn = $("#search-btn");
  if (btn) btn.disabled = busyDepth > 0;
  document.body.classList.toggle("loading", busyDepth > 0);
}

function skeleton(rows, label) {
  const line = `<div class="sk-row"><span class="sk sk-sq"></span><span class="sk sk-line"></span><span class="sk sk-line short"></span></div>`;
  return `<div class="skeleton" aria-label="${label || "载入中"}">
    <div class="sk-head"><span class="sk sk-line w40"></span><span class="sk sk-line w20"></span></div>
    ${line.repeat(rows || 5)}
    <div class="sk-note">正在拉取数据…</div>
  </div>`;
}

function showError(message, actionHtml = "") {
  const box = $("#error");
  box.innerHTML = escapeHtml(message) + actionHtml;
  box.classList.remove("hidden");
}

function clearError() {
  $("#error").classList.add("hidden");
}

function tierChip(row) {
  const name = row.tier_after_name || "";
  const iconUrl = row.tier_after_icon || "";
  const promo = row.promoted ? '<span class="promo">晋级</span>' : "";
  if (name || iconUrl) {
    const icon = iconUrl ? `<img class="tier-mini" src="${img(iconUrl)}" alt="" loading="lazy" />` : "";
    return `<span class="tier-chip">${icon}<span>${name || "—"}</span>${promo}</span>`;
  }
  // 赛后段位没拿到（非常规模式/PD 结算延迟）时，退回到玩家当前段位，至少图标不空。
  const me = state.player || {};
  if (!me.tier && !me.tier_icon) return "";
  const icon = me.tier_icon ? `<img class="tier-mini" src="${img(me.tier_icon)}" alt="" loading="lazy" />` : "";
  return `<span class="tier-chip muted">${icon}<span>${me.tier || "—"}</span></span>`;
}

function rrShort(delta) {
  const n = Number(delta);
  if (!Number.isFinite(n) || n === 0) return "";
  return n > 0
    ? `<span class="rr up" title="本局段位分变化">+${n}</span>`
    : `<span class="rr down" title="本局段位分变化">${n}</span>`;
}

function fmtDelta(delta) {
  if (delta === null || delta === undefined || delta === "") return "";
  const n = Number(delta);
  if (!Number.isFinite(n) || n === 0) return "";
  const sign = n > 0 ? "+" : "-";
  const cls = n > 0 ? "up" : "down";
  return `<span class="rr ${cls}" title="本局段位分变化">${sign}${Math.abs(n)} 分</span>`;
}

function squadTag(row) {
  if (!row.party || row.party < 2) return '<span class="party-badge solo">单排</span>';
  const label = { 2: "双排", 3: "三排", 4: "四排", 5: "五排" }[row.party] || `${row.party} 人组队`;
  return `<span class="party-badge n${Math.min(row.party, 5)}">${label}</span>`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function renderSummary(summary) {
  const box = $("#summary");
  if (!box) return;
  if (!summary || !summary.matches) {
    box.innerHTML = "";
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const mates = (summary.mates || [])
    .map((m) => `<button type="button" class="mate-chip" data-name="${escapeHtml(m.name || "")}">${escapeHtml(m.name || "")}<i>${m.games} 场</i></button>`)
    .join("");
  const chips = (summary.recent || [])
    .map(
      (r) => `<button type="button" class="mchip ${String(r.win) === "1" ? "w" : "l"}" data-match="${r.match_id}">
        <b>${escapeHtml(r.map || "—")}</b><span>${escapeHtml(r.kd || "")}</span><i>${r.acs || 0} ACS${r.party >= 2 ? " · " + r.party + " 排" : ""}</i>
      </button>`
    )
    .join("");
  // 对局机房：按最近对局的 gamePodId 投票（Riot 不公开玩家 IP，这是最接近的口径）
  const home = (state.player && state.player.home_server) || null;
  const pods = home
    ? [
        `<span class="dim">近 ${home.total} 场：</span>`,
        `<span class="pod-chip main" title="${escapeHtml(home.provider || "")}">${escapeHtml(home.label || home.region || home.code)} ${home.samples} 场</span>`,
        ...(home.others || []).map((o) => `<span class="pod-chip">${escapeHtml(o.label || o.region)} ${o.games} 场</span>`),
      ].join("")
    : "";
  box.innerHTML = `
    <div class="sum-head"><span class="kicker">近 ${summary.decided ?? summary.matches} 场总结</span>
      <span class="sum-sub">${summary.scope ? summary.scope + " · " : ""}胜 ${summary.wins} · 负 ${summary.losses} · ${
        summary.party_known ? `组队 ${summary.party_games} 场（${summary.party_rate ?? 0}%）` : "长历史不含组队信息"
      }${summary.rr_total !== null && summary.rr_total !== undefined ? ` · RR 累计 ${summary.rr_total > 0 ? "+" : ""}${summary.rr_total}（${summary.rr_games} 场）` : ""}</span>
    </div>
    <div class="sum-stats">
      <div><i>胜率</i><b>${summary.win_rate}%</b></div>
      <div><i>K/D</i><b>${summary.kd}</b></div>
      <div><i>ACS</i><b>${summary.acs}</b></div>
      <div><i>组队率</i><b>${summary.party_rate != null ? summary.party_rate + "%" : "—"}</b></div>
    </div>
    <div class="sum-line"><span class="k">最近战绩（点一下看单场）</span><div class="mchips">${chips || '<span class="dim">—</span>'}</div></div>
    <div class="sum-line"><span class="k">对局机房</span><div class="pods">${pods || '<span class="dim">暂无机组数据</span>'}</div></div>
    <div class="sum-line"><span class="k">常一起排</span><div class="mates" id="summary-mates">${mates || '<span class="dim">暂无（去「好友与组队」扫一次）</span>'}</div></div>`;
  box.querySelectorAll("[data-match]").forEach((el) => el.addEventListener("click", (ev) => {
    ev.preventDefault();
    loadMatch(el.dataset.match, null);
  }));
  bindMateChips(box);
}

function bindMateChips(scope) {
  if (!scope) return;
  scope.querySelectorAll("[data-name]").forEach((el) =>
    el.addEventListener("click", () => {
      if (!el.dataset.name) return;
      const input = $("#search-input");
      if (input) input.value = el.dataset.name;
      loadPlayer(el.dataset.name);
    })
  );
}

// 「常一起排」原来只在 /api/player 里取（服务端用上次的好友扫描缓存），
// 于是点「好友与组队」重新扫完之后这块还是旧的。扫完直接把结果同步过来。
function syncSummaryMates() {
  const host = $("#summary-mates");
  if (!host || !socialCache) return;
  const people = [...(socialCache.strangers || []), ...(socialCache.friends || [])]
    .filter((p) => p && p.name)
    .slice(0, 3);
  host.innerHTML = people.length
    ? people
        .map(
          (p) =>
            `<button type="button" class="mate-chip" data-name="${escapeHtml(p.name)}">${escapeHtml(p.name)}<i>${p.games} 场</i></button>`
        )
        .join("")
    : '<span class="dim">近一个月没有一起排过的人</span>';
  bindMateChips(host);
}

function renderTiles(stats) {
  $("#tiles").innerHTML = `
    <div class="tile accent"><div class="k">WIN RATE</div><div class="v">${stats.win_rate}<small>%</small></div></div>
    <div class="tile"><div class="k">KDA</div><div class="v">${stats.kda}</div></div>
    <div class="tile gold"><div class="k">AVG ACS</div><div class="v">${stats.acs}</div></div>
    <div class="tile warn"><div class="k">PARTY</div><div class="v">${stats.party_rate}<small>%</small></div></div>`;
}

function renderRank(rank) {
  const box = $("#rank-badge");
  if (rank && rank.tier) state.rank = rank;
  if (!box) return;
  if (!rank || !rank.tier) {
    const fallback = (state.player && state.player.tier) || "";
    box.innerHTML = fallback
      ? `<i>当前段位</i><b>${fallback}</b><span>分值未公开</span>`
      : '<i>当前段位</i><b>未定级</b>';
    box.classList.add("unranked");
    return;
  }
  box.classList.remove("unranked");
  const delta = rank.delta ? `${rank.delta > 0 ? "+" : ""}${rank.delta}` : "";
  const bits = [];
  if (rank.rr) bits.push(`${rank.rr} 分`);
  if (delta) bits.push(`最近 ${delta} 分`);
  const badgeIcon = rank.tier_icon
    ? `<img class="tier-ico" src="${img(rank.tier_icon)}" alt="" />`
    : "";
  box.innerHTML = `<i>当前段位</i><b>${badgeIcon}${rank.tier_name}</b><span>${bits.join(" · ") || "—"}</span>`;
}

function renderDataMeta(meta) {
  const box = $("#data-meta");
  if (!meta) { box.classList.add("hidden"); return; }
  const when = meta.fetched_at ? new Date(meta.fetched_at * 1000) : null;
  const hhmmss = when ? when.toTimeString().slice(0, 8) : "—";
  const ago = meta.age < 60 ? `${meta.age} 秒前` : `${Math.round(meta.age / 60)} 分钟前`;
  const stale = meta.age >= (meta.ttl || 3600);
  box.className = `data-meta${stale ? " stale" : ""}`;
  box.innerHTML = `<span class="dot"></span><span>${meta.cached ? "本地缓存" : "刚刚拉取"} · 数据更新于 <b>${hhmmss}</b>（${ago}）</span>
    <button type="button" id="refresh-now">刷新</button>`;
  $("#refresh-now").addEventListener("click", () => loadPlayer(state.keyword, true));
}

let watchTimer = null;

function stopWatch() {
  if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
}

function startWatch() {
  stopWatch();
  watchTimer = setInterval(checkWatch, 60000);
}

async function checkWatch() {
  if (!state.keyword || document.hidden) return;
  const keyword = state.keyword;
  const mode = state.source;
  try {
    const data = await api.get("/api/player/watch", { keyword, mode });
    if (!data.changed || keyword !== state.keyword) return;
    const box = $("#data-meta");
    box.className = "data-meta stale has-new";
    box.innerHTML = `<span class="dot"></span><span>检测到新对局（最新 <b>${String(data.latest_match).slice(0, 8)}</b>，共 ${data.total} 场）· 档案可能过期</span>
      <button type="button" id="refresh-now">刷新档案</button>`;
    $("#refresh-now").addEventListener("click", () => loadPlayer(keyword, true));
  } catch (_) { /* silent by design */ }
}

async function bindAppNum(p) {
  const current = String(p.app_num || "");
  const editing = Boolean(current);
  const tip = editing
    ? `修改 ${p.label} 的掌瓦号（现在是 ${current}；9 位数字，例如 038214488）：`
    : `把 ${p.label} 的掌瓦号绑到这个游戏ID上（9 位数字，例如 038214488）：`;
  const raw = window.prompt(tip, editing ? current : "");
  if (raw === null) return;
  const number = String(raw).replace(/\D/g, "");
  if (number.length !== 9) {
    showError("掌瓦号是 9 位数字，例如 038214488。");
    return;
  }
  if (editing && number === current) return;
  try {
    setBusy(true, "正在绑定掌瓦号");
    await api.post(`/api/player/appnum?keyword=${encodeURIComponent(p.label)}&mode=${encodeURIComponent(state.source)}&app_num=${number}`);
    await loadPlayer(p.label, true);
  } catch (err) {
    showError("绑定失败：" + err.message);
  } finally {
    setBusy(false);
  }
}

function renderRail() {
  const rows = state.rows || [];

  const maps = $("#rail-maps");
  if (maps) {
    const byMap = new Map();
    rows.forEach((row) => {
      const name = row.map || "";
      if (!name) return;
      const slot = byMap.get(name) || { name, n: 0, win: 0 };
      slot.n += 1;
      if (row.win === 1) slot.win += 1;
      byMap.set(name, slot);
    });
    const list = [...byMap.values()].sort((a, b) => b.n - a.n).slice(0, 5);
    maps.innerHTML = list.length
      ? list.map((m) => {
        const rate = Math.round((m.win / m.n) * 100);
        return `<div class="rail-item" title="${escapeHtml(m.name)} · ${m.n} 场 · 胜 ${m.win} 场（${rate}%）">
          <span class="name">${escapeHtml(m.name)}</span>
          <span class="bar"><i style="width:${Math.max(3, rate)}%"></i></span>
          <span class="pct">${m.n} 场 ${rate}%</span>
        </div>`;
      }).join("")
      : '<p class="none">本页还没有对局</p>';
  }

  const agents = $("#rail-agents");
  if (agents) {
    const recent = rows.slice(0, 10);
    agents.innerHTML = recent.length
      ? recent.map((row) => {
        const label = `${row.agent || "未知英雄"} · ${row.start_time || ""}${row.win === 1 ? " · 胜" : row.win === 0 ? " · 负" : ""}`;
        return row.agent_icon
          ? `<img src="${img(row.agent_icon)}" alt="${escapeHtml(row.agent || "")}" title="${escapeHtml(label)}" loading="lazy" />`
          : `<span class="none" title="${escapeHtml(label)}">?</span>`;
      }).join("")
      : '<p class="none">本页还没有对局</p>';
  }
}


async function loadPlayer(keyword, refresh = false) {
  setBusy(true, "正在解析玩家");
  try {
  const __t = $("#history-rows");
  if (__t) __t.innerHTML = skeleton(6);

  clearError();
  $("#suggest").classList.add("hidden");
  state.keyword = keyword;
  state.page = 1;
  state.matchLoaded = false;
  state.matchId = null;
  socialCache = null;
  ["#social-people", "#party-bars", "#party-mates", "#party-rows", "#match-body",
    "#asset-skins", "#asset-cards", "#asset-sprays", "#asset-charms", "#asset-agents"].forEach((sel) => {
    const node = document.querySelector(sel);
    if (node) node.innerHTML = "";
  });
  ["#social-meta", "#assets-meta", "#match-title", "#match-meta"].forEach((sel) => {
    const node = document.querySelector(sel);
    if (node) node.textContent = "";
  });
  // 第一页历史和玩家资料互不依赖：同时发，省掉一次完整往返（前端「渲染慢」的主要来源）。
  const firstPage = EXPORT_KIND ? null : prefetchHistory(keyword, refresh);
  try {
    const data = await api.get("/api/player", { keyword, mode: state.source, refresh });
  state.coverage = data.note || "";
    state.player = data.player;
    const p = data.player;
    $("#empty-state").classList.add("hidden");
    $("#player").classList.remove("hidden");
    $("#p-name").textContent = p.label;
    $("#p-level").textContent = p.level ? `LV ${p.level}` : "LV —";
    const fixedBox = $("#p-fixed");
    if (fixedBox) {
      const fixed = p.stable_id || "";
      fixedBox.textContent = fixed ? `固定ID ${fixed.slice(0, 8)}…` : "固定ID —";
      fixedBox.dataset.id = fixed;
      fixedBox.title = fixed
        ? `固定 ID（改名不变，可直接搜索）：${fixed}　点击复制`
        : "固定 ID：改名后依然能查到这个人的永久编号";
    }
    const appBox = $("#p-appnum");
    if (appBox) {
      if (p.app_num) {
        appBox.innerHTML = `<span class="appnum">掌瓦 ${escapeHtml(String(p.app_num))}</span>`
          + '<button type="button" class="bind-btn ghost" id="bind-btn" title="绑错了就点这里改">修改</button>';
        appBox.classList.remove("bindable");
        const editBtn = appBox.querySelector("#bind-btn");
        if (editBtn) editBtn.onclick = () => bindAppNum(p);
      } else {
        appBox.innerHTML = '<span class="appnum dim">掌瓦 未绑定</span><button type="button" class="bind-btn" id="bind-btn">绑定掌瓦号</button>';
        appBox.classList.add("bindable");
        const btn = appBox.querySelector("#bind-btn");
        if (btn) btn.onclick = () => bindAppNum(p);
      }
      appBox.title = p.app_num ? "掌瓦号（查询用的账号 ID）" : "掌瓦按昵称建索引，反查不到时可以手动填一次 9 位掌瓦号";
    }
    // 属地：掌瓦资料里的「最后登录 IP 属地」；对局机房分布放到「对局历史总结」里
    const srvBox = $("#p-server");
    if (srvBox) {
      const loc = p.mval_location || null;
      if (loc && loc.region) {
        srvBox.innerHTML = `<span class="srv">属地 ${escapeHtml(loc.region)}</span>`;
        const checked = stampText(loc.saved);
        srvBox.title = "掌瓦最后一次登录的 IP 属地（不是实时定位，来自掌瓦资料）"
          + (checked ? `\n上次核对：${checked}` : "");
        srvBox.classList.remove("hidden");
      } else {
        srvBox.textContent = "";
        srvBox.title = "";
        srvBox.classList.add("hidden");
      }
    }
    const avatar = $("#p-avatar");
    const fallback = $("#p-avatar-fallback");
    const drop = () => { avatar.style.visibility = "hidden"; fallback.classList.remove("hidden"); };
    avatar.onerror = drop;
    if (p.avatar) {
      avatar.src = img(p.avatar);
      avatar.style.visibility = "visible";
      fallback.classList.add("hidden");
      fallback.textContent = (p.name || "?").slice(0, 1);
    } else {
      drop();
    }
    renderDataMeta(data.meta);
    renderTiles(data.stats);
    // 换人必须先清空，否则上一个人的总结会留在页面上（「上一家的带到下一家」）
    const summaryBox = $("#summary");
    if (summaryBox) summaryBox.innerHTML = "";
    if (data.summary) renderSummary(data.summary);
    else if (summaryBox) summaryBox.innerHTML = '<p class="dim">暂无总结数据。</p>';
    renderRank(data.rank);
    startWatch();
    state.rows = data.recent;
    if (EXPORT_SORT) {
      state.assetSort = ["gun", "price", "unlock", "quality", "level"].includes(EXPORT_SORT) ? EXPORT_SORT : "unlock";
      state.assetOrder = EXPORT_ORDER === "asc" ? "asc" : "desc";
      const sortBox = $("#asset-sort");
      if (sortBox) sortBox.value = EXPORT_SORT;
    }
    if (EXPORT_KIND === "history") {
      state.size = EXPORT_SIZE;
      state.filter = EXPORT_FILTER;
      state.page = EXPORT_PAGE;
      await loadPage(EXPORT_PAGE);
    } else if (EXPORT_KIND) {
      renderHistory(data.recent, { total: data.stats.matches, page: 1, size: 10 });
    } else {
      await loadPage(1, false, firstPage);
    }
    switchTab(EXPORT_KIND || "history");
    if (!EXPORT_KIND) {
      rememberSearch(keyword);
      renderSearchHistory();
    }
    if (!EXPORT_KIND && state.pendingTab) switchTab(state.pendingTab);
    if (EXPORT_KIND === "match") {
      // 后端逐场导出时直接给 match_id：以前按列表下标取，导出页的历史列表和
      // 用户当前页不一致时第 3 场起会退化成同一场，几页长得一模一样。
      const explicit = _QUERY.get("match_id");
      if (explicit) {
        await loadMatch(explicit);
      } else {
        const rows = [...document.querySelectorAll("#history-rows .row")];
        const row = rows[EXPORT_MATCH] || rows[0];
        const id = row?.dataset.match;
        if (id) await loadMatch(id);
      }
    }
  } catch (err) {
    stopWatch();
    const detail = err.detail && typeof err.detail === "object" ? err.detail : null;
    const action = detail && detail.relogin === "aclos"
      ? ''
      : "";
    showError(`查询失败：${err.message}`, action);
    // 人已经找到了（只是换不出 PUUID）时不用再提供「是不是这个」候选，那反而更乱。
    if (!(detail && detail.found)) suggest(keyword);
  }

  } finally {
    setBusy(false);
  }
}

async function suggest(keyword) {
  const box = $("#suggest");
  const name = keyword.includes("#") ? keyword.split("#")[0] : keyword;
  if (!name) return;
  box.classList.remove("hidden");
  box.innerHTML = "";
  try {
    const data = await api.get("/api/search", { q: name });
    const items = (data.items || []).slice(0, 6);
    if (!items.length) { box.classList.add("hidden"); return; }
    box.innerHTML = `<p>没找到「${escapeHtml(keyword)}」，是不是其中一位？</p>` + items
      .map((item) => `<button type="button" data-uid="${escapeHtml(item.uuid)}" data-name="${escapeHtml(item.name)}">`
        + `${escapeHtml(item.name)}<em>${item.app_num ? `掌瓦 ${escapeHtml(item.app_num)}` : ""}</em></button>`)
      .join("");
    $$("#suggest button").forEach((btn) => btn.addEventListener("click", () => {
      box.classList.add("hidden");
      // 以前直接拿 btn.textContent 回填，那是「名字 + 掌瓦号」粘在一起（彩虹精005346494），
      // 回填进去下次搜索必然查不到；这里用 data-name 只填掌瓦昵称。
      $("#search-input").value = btn.dataset.name || "";
      loadPlayer(`uid:${btn.dataset.uid}`);
    }));
  } catch (_) {
    box.innerHTML = "";
  }
}

function shortDate(text) {
  // "2026-10-24 18:59" → "2026-10-24"（年月日都要带上）
  return text && text.length >= 10 ? text.slice(0, 10) : "";
}

function clock(text) {
  // "2026-10-24 18:59" → "18:59"
  return text && text.length >= 16 ? text.slice(11, 16) : "";
}

function msClock(ms) {
  if (!ms) return "";
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function msDay(ms) {
  // 统一「YYYY-MM-DD」：以前只给月日，跨年就分不清了
  return msFullDay(ms);
}

function msFullDay(ms) {
  if (!ms) return "";
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function timeRange(row) {
  // 优先用毫秒时间戳，让浏览器按本地时区显示（服务端可能是 UTC）
  if (row.start_ms) {
    const day = msDay(row.start_ms);
    const start = msClock(row.start_ms);
    const end = msClock(row.end_ms);
    return end ? `${day} ${start} → ${end}` : `${day} ${start}`;
  }
  if (!row.start_time && /^\d{2}-\d{2} \d{2}:\d{2}$/.test(String(row.time || ""))) {
    // 掌瓦长历史只给「10-22 13:22」，补上今年（跨年时按「不晚于现在」推算年份）
    const [md, hm] = String(row.time).split(" ");
    const now = new Date();
    let year = now.getFullYear();
    const guess = new Date(`${year}-${md}T${hm}:00`);
    if (!Number.isNaN(guess.getTime()) && guess.getTime() > now.getTime() + 86400000) year -= 1;
    return `${year}-${md} ${hm}`;
  }
  const start = row.start_time || row.time || "";
  const end = row.end_time || "";
  const day = shortDate(start);
  if (clock(start) && clock(end)) return `${day} ${clock(start)} → ${clock(end)}`;
  if (clock(start)) return `${day} ${clock(start)}`;
  return day || "时间未知";
}

function msLength(ms) {
  const total = Math.round(Number(ms || 0) / 1000);
  if (!total || total < 0) return "";
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return m ? `${m} 分 ${sec} 秒` : `${sec} 秒`;
}

function rowSeconds(row) {
  const ms = Number(row.duration_ms || 0) || (row.start_ms && row.end_ms ? Number(row.end_ms) - Number(row.start_ms) : 0);
  return ms > 0 ? Math.round(ms / 1000) : 0;
}

// 连杀标注：三杀/四杀/五杀…（列表页标自己这局的，记分板标每个人的）
function multiBadges(list, size = "") {
  const rows = (list || []).filter((m) => m && m.count);
  if (!rows.length) return "";
  // 一个人最多能同时亮起 三杀/四杀/五杀/六杀/七杀 五种，行内塞不下就折成 +N
  const cap = 2;
  const shown = rows.slice(0, cap);
  const rest = rows.slice(cap);
  const more = rest.length
    ? `<em class="more" title="${escapeHtml(rest.map((m) => `${m.label}${m.count > 1 ? ` × ${m.count}` : ""}`).join("、"))}">+${rest.length}</em>`
    : "";
  const withCount = size !== "mini";
  const body = shown
    .map((m) => `<em title="${escapeHtml(m.label || "")} × ${m.count}">${escapeHtml(m.label || "")}${
      withCount || m.count > 1 ? `<i>×${m.count}</i>` : ""
    }</em>`)
    .join("");
  return `<span class="multis${size ? ` ${size}` : ""}">${body}${more}</span>`;
}

function rowHtml(row) {
  const win = Number(row.win) === 1;
  const draw = row.draw === true;
  const cls = draw ? "draw" : win ? "win" : "loss";
  const res = draw ? "平局" : win ? "胜利" : "失败";
  const kda = `${row.kills}<small>/</small>${row.deaths}<small>/</small>${row.assists}`;
  const rounds = row.rounds_for || row.rounds_against
    ? `<span class="rounds">${row.rounds_for}<small>:</small>${row.rounds_against}</span>`
    : '<span class="rounds">—</span>';
  const score = row.acs ? `<span class="acs">${rounds} · ${row.acs} ACS</span>` : `<span class="acs">${rounds}</span>`;
  return `
    <a class="row ${cls}" data-match="${escapeHtml(row.match_id)}" href="#"${row.map_cover ? ` style="--cover:url('${img(row.map_cover)}')"` : ""}>
      <span class="spine"></span>
      <span class="agent">${row.agent_icon ? `<img src="${img(row.agent_icon)}" alt="">` : `<span class="blank"></span>`}</span>
      <div class="map">
        <b><span class="map-name">${escapeHtml(row.map || "未知地图")}</span>${squadTag(row)}</b>
        <span>${timeRange(row)}${
          rowSeconds(row) ? `<span class="dur" title="对局时长 ${msLength(rowSeconds(row) * 1000)}">${Math.max(1, Math.round(rowSeconds(row) / 60))} 分钟</span>` : ""
        }</span>
      </div>
      <div class="mode"><span class="mode-chip">${escapeHtml(row.mode_name || "未知模式")}</span>${multiBadges(row.multis, "mini")}</div>
      <div class="tier">${tierChip(row) || '<span class="tier-none">未定级</span>'}${rrShort(row.rr)}</div>
      <div class="mid"><span class="kda">${kda}</span>${score}</div>
      <div class="tail"><span class="res">${res}</span></div>
    </a>`;
}

function renderHistory(rows, meta) {
  state.rows = rows;
  state.page = meta.page;
  state.total = meta.total;
  const list = $("#history-rows");
  // 一律按开始时间倒序。以前把「组队场」整段提到最上面，最新的单人局会被
  // 24 号那几把四排挤到第 7 行，看起来就像「25 号打的那把没记录」。
  const ordered = [...rows].sort(
    (a, b) => (Number(b.start_ms || b.ts || 0)) - (Number(a.start_ms || a.ts || 0)),
  );
  list.innerHTML = ordered.map(rowHtml).join("") || '<p class="dim">这一页没有记录。</p>';
  const pages = Math.max(1, Math.ceil((meta.total || 0) / meta.size));
  $("#page-label").textContent = meta.has_next ? `${meta.page} / ${pages}+` : `${meta.page} / ${pages}`;
  $("#prev").disabled = meta.page <= 1;
  $("#next").disabled = !meta.has_next;
  const note = $("#history-note");
  if (note) note.textContent = state.coverage || "";
  $$("#history-rows .row").forEach((el) => {
    el.addEventListener("click", (ev) => {
      ev.preventDefault();
      loadMatch(el.dataset.match, el);
    });
  });
  renderRail();
}

const partyRank = (row) => (Number(row && row.party) >= 2 ? 1 : 0);

function prefetchHistory(keyword, refresh) {
  return api
    .get("/api/player/history", {
      keyword, page: 1, size: state.size, mode: state.source, filter: state.filter, gm: state.gm, refresh,
    })
    .catch(() => null); // 预取失败就当没做，等 loadPage 自己再打一次
}

// 「查看模式」下拉的选项以后端 mode_groups 为准：分类规则只写在 server/valo/names.py
// 一处，前端不再硬编码一份（index.html 里那份只是没 JS 时的兜底）。
function syncModeOptions(payload) {
  const box = $("#view-mode");
  const groups = payload && payload.mode_groups;
  if (!box || !Array.isArray(groups) || !groups.length) return;
  const sig = groups.map((g) => `${g.id}:${g.label}`).join("|");
  if (box.dataset && box.dataset.modeSig === sig) {
    syncModeChips();
    return;
  }
  box.innerHTML = groups
    .map((g) => `<button type="button" class="chip" data-gm="${escapeHtml(g.id)}">${escapeHtml(g.label)}</button>`)
    .join("");
  if (box.dataset) box.dataset.modeSig = sig;
  syncModeChips();
}

// 「查看模式」做成和对局记录里「全部 / 只看组队」一样的小按钮
function syncModeChips() {
  $$("#view-mode button").forEach((btn) =>
    btn.classList.toggle("active", (btn.dataset.gm || "all") === state.gm));
}

async function loadPage(page, refresh = false, prefetched = null) {
  try {
    const data = (prefetched && page === 1 ? await prefetched : null)
      || (await api.get("/api/player/history", {
        keyword: state.keyword, page, size: state.size, mode: state.source, filter: state.filter, gm: state.gm, refresh,
        ...(EXPORT_DATE_FROM ? { date_from: EXPORT_DATE_FROM } : {}),
        ...(EXPORT_DATE_TO ? { date_to: EXPORT_DATE_TO } : {}),
      }));
    syncModeOptions(data);
    state.coverage = data.note || "";
    renderDataMeta(data.meta);
    renderHistory(data.rows, data);
  } catch (err) {
    showError(`翻页失败：${err.message}`);
  }
}

// 单局详情有两种打开方式，用户在「对局记录」工具栏里自己选（存 localStorage）：
//  · page   —— 切到「单局详情」独立页：完整记分板 + 回合趋势 + 对位击杀
//  · inline —— 就地在列表里展开一张小卡：只有名单和 KDA/ACS，想细看再跳单页
const OPEN_MODE_KEY = "valo.openMode";

function openMode() {
  try {
    return localStorage.getItem(OPEN_MODE_KEY) === "inline" ? "inline" : "page";
  } catch (err) {
    return "page";
  }
}

function syncOpenModeUI() {
  const mode = openMode();
  $$("#open-mode button").forEach((btn) => btn.classList.toggle("active", btn.dataset.open === mode));
}

function setOpenMode(mode) {
  try {
    localStorage.setItem(OPEN_MODE_KEY, mode === "inline" ? "inline" : "page");
  } catch (err) {
    /* 隐私模式下 localStorage 会抛，忽略即可 */
  }
  syncOpenModeUI();
  if (mode !== "inline") clearQuickCards();
}

function clearQuickCards() {
  $$("#history-rows .inline-quick").forEach((el) => el.remove());
}

async function loadMatch(matchId, rowEl) {
  state.matchId = matchId;
  state.matchLoaded = true;
  // 导出截图只认「单局详情」页里的 #match-body，所以导出模式永远走独立页。
  if (EXPORT_KIND || openMode() === "page") {
    clearQuickCards();
    await showMatchTab(matchId);
    return;
  }
  const anchor = rowEl && rowEl.closest && rowEl.closest("#history-rows")
    ? rowEl
    : $(`#history-rows .row[data-match="${matchId}"]`);
  if (anchor) {
    await toggleQuick(matchId, anchor);
    return;
  }
  await showMatchTab(matchId);
}

// 就地展开/收起；同时只留一块，避免列表被撑爆。
async function toggleQuick(matchId, rowEl) {
  const anchor = rowEl || $(`#history-rows .row[data-match="${matchId}"]`);
  if (!anchor) return;
  const opened = $$("#history-rows .inline-quick");
  const mine = opened.find((el) => el.dataset.match === matchId);
  opened.forEach((el) => {
    if (el !== mine) el.remove();
  });
  if (mine) {
    mine.remove();
    return;
  }
  const host = document.createElement("div");
  host.className = "inline-quick";
  host.dataset.match = matchId;
  host.innerHTML = `<div class="iq-loading">${skeleton(2)}</div>`;
  anchor.after(host);
  try {
    const data = await api.get("/api/match", { keyword: state.keyword, match_id: matchId, mode: state.source });
    renderQuickMatch(data, matchId, host);
    const box = host.getBoundingClientRect();
    if (box.top > window.innerHeight * 0.6 || box.bottom < 0) {
      host.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  } catch (err) {
    host.remove();
    showError(`详情加载失败：${err.message}`);
  }
}

const TEAM_COLORS = ["#3d9ef0", "#e85a5a", "#f0b429", "#3ec98a", "#a97bf0", "#f08a3d", "#3dc9cf", "#ef7fc0"];
const TEAM_COLOR_NAMES = ["蓝", "红", "黄", "绿", "紫", "橙", "青", "粉"];

// 队名 → 队伍编号（Team_7 → 7）；PD 的 teams[] 里有 team_number 就优先用。
function teamNumber(teamId, teams) {
  const info = (teams || []).find((t) => String(t.team_id || "") === String(teamId || ""));
  if (info && Number(info.team_number)) return Number(info.team_number);
  const digits = String(teamId || "").replace(/\D+/g, "");
  return digits ? Number(digits) : 0;
}

function teamPalette(teamId, teams) {
  const number = teamNumber(teamId, teams);
  // 后端已经按掌瓦的叫法补好了颜色/动物名/名次（异变轮战 8 队），优先用它：
  // 颜色和名字只写在一处（server/valo/names.py），前端不再各存一份。
  const info = (teams || []).find((t) => String(t.team_id || "") === String(teamId || ""));
  if (info && info.color) {
    return {
      color: info.color,
      name: info.name || TEAM_COLOR_NAMES[((number || 1) - 1) % TEAM_COLOR_NAMES.length],
      label: info.label || "",
      colorName: info.color_name || "",
      placement: Number(info.placement || 0),
      kills: info.kills,
      deaths: info.deaths,
      number,
    };
  }
  const idx = ((number || 1) - 1) % TEAM_COLORS.length;
  return { color: TEAM_COLORS[idx], name: TEAM_COLOR_NAMES[idx], number };
}

// 多人分队模式（异变轮战是 8 队各 2 人）不能按红蓝两方排，得按 teamId 分组。
function distinctTeams(score) {
  return [...new Set((score || []).map((seat) => String(seat.team || "")).filter(Boolean))];
}

function renderQuickMatch(payload, matchId, host) {
  const detail = payload.detail || {};
  const score = payload.scoreboard || [];
  const teams = payload.teams || [];
  const won = String(detail.victory) === "1";
  const teamIds = distinctTeams(score);
  const multiTeam = teamIds.length > 2;
  const srv = detail.server || {};
  const srvLabel = srv.label || srv.region || srv.code || "";
  const whenText = detail.start_text || (detail.start_millis ? msFullDay(detail.start_millis) : "");
  const meta = [
    detail.game_mode_name || "",
    whenText ? `开局 ${whenText}` : "",
    srvLabel ? `服务器 ${srvLabel}` : "",
    detail.duration ? `用时 ${detail.duration}` : "",
  ].filter(Boolean).join(" · ");
  // 后端已经按「阵营 → 小队 → 评分」排好，就地查看保持这个顺序，组队的人才会挨在一起。
  const ordered = multiTeam
    ? [...score].sort((a, b) => teamNumber(a.team, teams) - teamNumber(b.team, teams))
    : [...score];
  const squadList = (payload.squads || []).filter((sq) => Number(sq.size) >= 2);
  const squadText = squadList.length
    ? squadList.map((sq, i) => `${"ABCD"[i] || "?"}队 ${sq.size} 人`).join(" · ")
    : "全场单排";
  const rowOf = (seat) => {
    const pal = teamPalette(seat.team, teams);
    const kda = String(seat.kda || "0/0/0").split("/");
    const face = seat.agent_image
      ? `<img class="iq-face" src="${img(seat.agent_image)}" alt="" loading="lazy" onerror="this.remove()" />`
      : '<span class="iq-face blank"></span>';
    const teamCell = multiTeam
      ? `<td class="iq-team"><i class="team-dot" style="--team-color:${pal.color}"></i>${escapeHtml(pal.name || (pal.number ? `队${pal.number}` : "—"))}</td>`
      : "";
    // 段位图标、队徽都占固定格子：没有的补空占位，否则有队徽的行名字会被挤右。
    const tierIcon = seat.tier_icon
      ? `<img class="iq-tier" src="${img(seat.tier_icon)}" alt="" title="${escapeHtml(seat.tier_name || "未定级")}" loading="lazy" onerror="this.remove()" />`
      : '<span class="iq-tier blank"></span>';
    const squadBadge = seat.party_letter
      ? `<span class="party-lg" style="background:var(--squad-${"ABCD".indexOf(seat.party_letter) + 1})">${seat.party_letter}队</span>`
      : Number(seat.party_size) >= 2
        ? `<span class="party-lg solo">${seat.party_size}人</span>`
        : '<span class="party-lg blank"></span>';
    return `<tr class="${seat.subject === payload.viewer ? "me" : ""}${seat.is_ally ? " team-ally" : ""}">
      ${teamCell}
      <td class="iq-who"><span class="nm${seat.display_name || seat.user_name ? "" : " nm-unknown"}">${tierIcon}${squadBadge}${escapeHtml(seat.display_name || seat.user_name || "未知玩家")}${seat.subject === payload.viewer ? '<em class="you">你</em>' : ""}</span></td>
      <td class="iq-agent">${face}<span>${escapeHtml(seat.used_agent?.name || "—")}</span></td>
      <td class="num">${kda[0] || 0}</td>
      <td class="num">${kda[1] || 0}</td>
      <td class="num">${kda[2] || 0}</td>
      <td class="num">${seat.acs || 0}</td>
      <td class="num">${seat.score || 0}</td>
    </tr>`;
  };
  const head = multiTeam
    ? `<th>队伍</th><th>玩家</th><th>英雄</th><th class="num">K</th><th class="num">D</th><th class="num">A</th><th class="num">ACS</th><th class="num">评分</th>`
    : `<th>玩家</th><th>英雄</th><th class="num">K</th><th class="num">D</th><th class="num">A</th><th class="num">ACS</th><th class="num">评分</th>`;
  host.innerHTML = `
    <div class="iq-head">
      <div class="iq-main">
        <b>${escapeHtml(detail.map_name || detail.used_map?.name || "未知地图")} · <span class="${won ? "win" : "loss"}">${won ? "胜利" : "失败"}</span>
          <em>${detail.winning_games ?? "—"} : ${detail.failed_games ?? "—"}</em></b>
        <span class="iq-meta">${escapeHtml(meta)}</span>
        <span class="iq-squads">组队 <b>${escapeHtml(squadText)}</b></span>
      </div>
      <div class="iq-acts">
        <button type="button" class="iq-page">完整单页 →</button>
        <button type="button" class="iq-close" aria-label="收起">收起</button>
      </div>
    </div>
    <div class="iq-scroll">
      <table class="iq-table">
        <thead><tr>${head}</tr></thead>
        <tbody>${ordered.map(rowOf).join("") || '<tr><td class="dim" colspan="8">没有记分板数据。</td></tr>'}</tbody>
      </table>
    </div>
    <p class="iq-note">就地查看放名单、KDA 和组队情况；<b>回合趋势</b>和<b>对位击杀</b>在「完整单页」里。</p>`;
  const page = host.querySelector(".iq-page");
  if (page) {
    page.addEventListener("click", () => {
      host.remove();
      showMatchTab(matchId);
    });
  }
  const close = host.querySelector(".iq-close");
  if (close) close.addEventListener("click", () => host.remove());
}

async function showMatchTab(matchId) {
  setBusy(true, "正在读取单局");
  try {
    const body = $("#match-body");
    if (body) body.innerHTML = skeleton(0);
    clearError();
    try {
      const data = await api.get("/api/match", { keyword: state.keyword, match_id: matchId, mode: state.source });
      renderMatch(data, matchId);
      switchTab("match");
      const panel = $("#panel-match");
      if (panel && !document.body.classList.contains("export")) {
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    } catch (err) {
      showError(`详情加载失败：${err.message}`);
    }
  } finally {
    setBusy(false);
  }
}

// 单局详情放在独立的「单局详情」页：列表里点一行就切过去（用户要求别在历史下面展开）。

function renderMatch(payload, matchId, host) {
  const root = host || $("#match-body");
  const inline = Boolean(host);
  const detail = payload.detail || {};
  const score = payload.scoreboard || [];
  const squads = payload.squads || [];
  const won = String(detail.victory) === "1";
  const titleText = detail.used_map?.name ? `${detail.used_map.name} · ${won ? "胜利" : "失败"}` : "单局详情";
  const startMillis = Number(detail.start_millis || 0);
  const endMillis = Number(detail.end_millis || 0);
  const startText = startMillis ? "" : detail.start_text || "";
  const endText = endMillis ? "" : detail.end_text || "";
  const startClock = startMillis ? msClock(startMillis) : clock(startText);
  const endClock = endMillis ? msClock(endMillis) : clock(endText);
  const clockRange = startClock && endClock ? `${startClock} → ${endClock}` : startClock;
  // 单局详情要看到完整年月日 + 开局/结束时间（列表页仍然只显示月-日）
  const dayText = startMillis ? msFullDay(startMillis) : (startText || "").slice(0, 10);
  const startFull = [dayText, startClock].filter(Boolean).join(" ");
  const endFull = [dayText || (endText || "").slice(0, 10), endClock].filter(Boolean).join(" ");
  const whenText = startFull
    ? `开局 ${startFull}${endClock ? ` · 结束 ${endFull || endClock}` : ""}`
    : "";
  // 对局服务器：gamePodId 解析出来的机房城市 + 分组（游戏里显示成「天津 MIX4」）
  const srv = detail.server || {};
  const srvLabel = srv.label || srv.region || srv.code || "";
  const srvDetail = [srv.provider, srv.code].filter(Boolean).join(" ");
  const serverText = srvLabel
    ? `服务器 ${srvLabel}${srvDetail ? `（${srvDetail}）` : ""}`
    : "";
  const serverChip = srvLabel
    ? `<span class="tag-srv" title="${escapeHtml(srv.raw || "")}">服务器 · ${escapeHtml(srvLabel)}</span>`
    : "";
  const metaText = [
    detail.game_mode_name || "",
    whenText,
    serverText,
    detail.duration ? `用时 ${detail.duration}` : "",
    matchId.slice(0, 8),
  ].filter(Boolean).join(" · ");
  if (!inline) {
    const titleEl = $("#match-title");
    const metaEl = $("#match-meta");
    if (titleEl) titleEl.textContent = titleText;
    if (metaEl) metaEl.textContent = metaText;
  }

  const squadChips = squads
    .map((s, i) => `<span class="squad" style="background:var(--squad-${(i % 4) + 1})">${"ABCD"[i] || "?"}队 · ${s.size}人</span>`)
    .join("");

  // 异变轮战这类「多人分队」模式（8 队各 2 人）没法用红蓝两方表达，
  // 按 teamId 分组、每队一个颜色，行首写队号。
  const teamList = payload.teams || [];
  const teamIds = distinctTeams(score);
  const multiTeam = teamIds.length > 2;

  const seatRow = (seat) => {
    const ally = seat.is_ally ?? (seat.team === (payload.ally_team || score[0]?.team));
    const teamClass = ally ? "team-ally" : "team-enemy";
    const pal = teamPalette(seat.team, teamList);
    const side = multiTeam
      ? `${pal.number || "?"}`
      : String(seat.team || "").toLowerCase() === "red" ? "红" : "蓝";
    const sideStyle = multiTeam
      ? ` style="--side:${pal.color}" title="第 ${pal.placement || pal.number} 名 · ${pal.colorName}${pal.name}"`
      : "";
    const teamCls = multiTeam ? "side-color multi" : `side-color ${teamClass}`;
    const badge = seat.party_letter
      ? `<span class="party-lg" style="background:var(--squad-${"ABCD".indexOf(seat.party_letter) + 1})">${seat.party_letter}队</span>`
      : "";
    const tag = seat.party_size >= 2 ? `<span class="tag">${seat.party_size} 人组队</span>` : "";
    const face = seat.agent_image
      ? `<img class="face${multiTeam ? " team-tint" : ""}"${multiTeam ? ` style="--team-color:${pal.color}"` : ""} src="${img(seat.agent_image)}" alt="" loading="lazy" />`
      : "";
    return `<tr class="${seat.subject === payload.viewer ? "me" : ""} ${teamClass}">
      <td class="side" data-label="阵营"><i class="${teamCls}"${sideStyle}>${side}</i></td>
      <td class="who" data-label="玩家"><div class="seat">${face || '<span class="face blank"></span>'}<div class="seat-txt"><span class="nm${seat.display_name || seat.user_name ? " nm-click" : " nm-unknown"}"${seat.display_name || seat.user_name ? ` data-q="${escapeHtml(seat.display_name || seat.user_name)}" title="点一下查这名玩家"` : ' title="名字没取到：名字查询服务未登录，或这名玩家没绑定过游戏账号"'}>${escapeHtml(seat.display_name || seat.user_name || "未知玩家")}${seat.subject === payload.viewer ? '<em class="you">你</em>' : ""}</span><span class="who-tags">${badge}${tag}${multiBadges(seat.multis, "board")}</span></div></div></td>
      <td class="c-agent" data-label="英雄">${seat.used_agent?.name || "—"}</td>
      <td class="tier" data-label="段位">${seat.tier_icon ? `<img src="${img(seat.tier_icon)}" alt="" title="${seat.tier_name || ""}" loading="lazy" /><span>${seat.tier_name || ""}</span>` : seat.tier_name || "—"}</td>
      <td class="c-acs" data-label="ACS">${seat.acs || 0}</td>
      <td class="c-dpr" data-label="回合均伤">${seat.damage_per_round || 0}</td>
      <td class="c-hs" data-label="爆头率">${seat.headshot_rate || 0}%</td>
      <td class="c-fb" data-label="首杀">${seat.first_blood || 0}</td>
      <td class="c-kda" data-label="K/D/A">${seat.kda || "0/0/0"}</td>
      <td class="c-score" data-label="评分">${seat.score || 0}</td>
    </tr>`;
  };

  const groups = [
    { ally: true, label: "我方", rounds: detail.winning_games, cls: "team-ally" },
    { ally: false, label: "对方", rounds: detail.failed_games, cls: "team-enemy" },
  ];
  const teamSection = (teamId) => {
    const seats = score
      .filter((seat) => String(seat.team || "") === teamId)
      .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
    if (!seats.length) return "";
    const pal = teamPalette(teamId, teamList);
    const info = teamList.find((t) => String(t.team_id || "") === teamId) || {};
    const ally = seats.some((seat) => seat.is_ally);
    const bits = [
      pal.colorName ? `${pal.colorName}队` : "",
      pal.placement ? `第 ${pal.placement} 名` : "",
      `${seats.length} 人`,
      Number(info.kills) ? `击杀 ${info.kills}` : "",
      Number(info.deaths) ? `阵亡 ${info.deaths}` : "",
      info.won ? "本场第一" : "",
      ally ? "你在这队" : "",
    ].filter(Boolean).join(" · ");
    const head = `<tr class="board-sep team-multi${ally ? " team-ally" : ""}" style="--team-color:${pal.color}">
      <td colspan="10"><i class="team-dot"></i><b>${escapeHtml(pal.label || pal.name || `队伍 ${pal.number || "?"}`)}</b><span>${escapeHtml(bits)}</span></td></tr>`;
    return head + seats.map(seatRow).join("");
  };
  const rows = multiTeam
    ? [...teamIds].sort((a, b) => teamNumber(a, teamList) - teamNumber(b, teamList)).map(teamSection).join("")
    : groups
        .map((group) => {
          const seats = score.filter((seat) => {
            const ally = seat.is_ally ?? (seat.team === (payload.ally_team || score[0]?.team));
            return Boolean(ally) === group.ally;
          });
          if (!seats.length) return "";
          const head = `<tr class="board-sep ${group.cls}"><td colspan="10"><b>${group.label}</b><span>${group.rounds ?? "—"} 回合 · ${seats.length} 人</span></td></tr>`;
          return head + seats.map(seatRow).join("");
        })
        .join("");

  state.matchPayload = payload;
  const mySeat = score.find((seat) => seat.subject === payload.viewer) || {};
  const roundInfo = payload.rounds || {};
  const hasRounds = Boolean(roundInfo.count > 0);
  const hasMatrix = Boolean(((payload.kill_matrix || {}).cells || []).length);
  // 名字查询失败时（登录过期 / 对方没绑定过账号）display_name 是空的，
  // 这些位置以前只画一根横线，看着像人机；这里给出明确文案并在表下提示原因。
  const nameless = score.filter((seat) => !String(seat.display_name || seat.user_name || "").trim());
  const nameNote = nameless.length
    ? `<p class="name-note">有 ${nameless.length} 名玩家没取到游戏 ID：名字查询服务没登录，或这个人没绑定过游戏账号。
       </p>`
    : "";

  const hero = `
    <div class="match-hero ${won ? "" : "loss"}">
      ${detail.map_image ? `<img class="map-cover" src="${img(detail.map_image)}" alt="" />` : ""}
      <div class="hero-main">
        <div class="hero-map">${escapeHtml(detail.map_name || detail.used_map?.name || "未知地图")}</div>
        <div class="hero-score"><b class="${won ? "win" : "loss"}">${detail.winning_games ?? "—"}</b><i>:</i><b>${detail.failed_games ?? "—"}</b></div>
        <div class="hero-tags">
          <span class="tag-mode">${detail.game_mode_name || ""}</span>
          <span class="res ${won ? "win" : "loss"}">${won ? "胜利" : "失败"}</span>
          ${payload.rank && payload.rank.rr ? `<span class="rr ${payload.rank.rr > 0 ? "up" : "down"}">${payload.rank.rr > 0 ? "+" : ""}${payload.rank.rr} 分</span>` : ""}
          ${payload.rank && payload.rank.promoted ? '<span class="promo">晋级</span>' : ""}
          ${serverChip}
        </div>
      </div>
      <div class="hero-when">${whenText || "时间未知"}${detail.duration ? ` · 用时 ${escapeHtml(detail.duration)}` : ""}</div>
      <div class="hero-stats">
        <div><span>我的表现</span><b>${mySeat.acs || 0} ACS</b></div>
        <div><span>我的 K/D/A</span><b>${mySeat.kda || "—"}</b></div>
      </div>
      <div class="squads">${squadChips || '<span class="dim">全场单排</span>'}</div>
    </div>`;

  const boardTable = `
    <div class="board-wrap">
      <table class="board">
        <thead><tr>
          <th>阵营</th><th>玩家</th><th>英雄</th><th>段位</th><th>ACS</th><th>回合均伤</th><th>爆头率</th><th>首杀</th><th>K/D/A</th><th>评分</th>
        </tr></thead>
        <tbody>${rows || '<tr><td colspan="10" class="dim">没有记分板数据。</td></tr>'}</tbody>
      </table>
    </div>`;

  const tabs = `
    <div class="match-tabs">
      <button class="mtab on" data-tab="board">战绩详情</button>
      ${hasRounds ? `<button class="mtab" data-tab="rounds">回合趋势<i class="mtab-badge">${roundInfo.count}</i></button>` : ""}
      ${hasMatrix ? '<button class="mtab" data-tab="kills">对位击杀</button>' : ""}
    </div>`;

  const inlineHead = inline
    ? `<div class="inline-head">
         <div class="ih-main">
           <b>${escapeHtml(titleText)}</b>
           <span class="ih-meta">${escapeHtml(metaText)}</span>
         </div>
         <div class="ih-acts">
           <button class="ih-page" type="button">单页打开</button>
           <button class="ih-close" type="button" aria-label="收起这一场">收起</button>
         </div>
       </div>`
    : "";

  root.innerHTML = `
    ${inlineHead}
    ${tabs}
    <div class="match-pane" data-pane="board">${hero}${boardTable}${nameNote}</div>
    ${hasRounds ? `<div class="match-pane hidden" data-pane="rounds">${roundMarkup(roundInfo)}</div>` : ""}
    ${hasMatrix ? `<div class="match-pane hidden" data-pane="kills">${killMatrixMarkup(payload)}</div>` : ""}`;
  bindMatchTabs(root);
  bindRounds(root, payload);
  if (inline) {
    const close = root.querySelector(".ih-close");
    if (close) close.addEventListener("click", () => root.remove());
    const page = root.querySelector(".ih-page");
    if (page) {
      page.addEventListener("click", () => {
        root.remove();
        showMatchTab(matchId);
      });
    }
  }
}

// 对位击杀热力图：行 = 击杀者，列 = 被他击杀的对手（两队交叉，最多 10×10）。
function killMatrixMarkup(payload) {
  const matrix = payload.kill_matrix || {};
  const cells = matrix.cells || [];
  const names = matrix.names || matrix.subjects || [];
  if (!cells.length || names.length < 2) return "";
  const board = payload.scoreboard || [];
  const seatOf = (i) => board[i] || {};
  const max = cells.reduce((acc, row) => Math.max(acc, ...row), 1);
  const av = (seat, cls = "km-av") =>
    seat.agent_image
      ? `<img class="${cls}" src="${img(seat.agent_image)}" alt="" title="${escapeHtml(seat.used_agent?.name || "")}" loading="lazy" onerror="this.remove()" />`
      : `<span class="${cls} blank"></span>`;
  const sideOf = (i) => (seatOf(i).is_ally ? "ally" : "enemy");
  const colHead = names
    .map((name, j) => {
      return `<th class="${sideOf(j)}" title="${escapeHtml(name)}"><span class="km-col">${av(seatOf(j))}<i>${j + 1}</i></span></th>`;
    })
    .join("");
  const rows = cells
    .map((row, i) => {
      const side = sideOf(i);
      const tds = row
        .map((count, j) => {
          if (i === j) return `<td class="km-self">${av(seatOf(i), "km-av me")}</td>`;
          const ratio = count / max;
          const alpha = count ? Math.round(16 + ratio * 78) : 0;
          const style = count ? ` style="--km-a:${alpha}%"` : "";
          const tip = `${names[i] || "?"} 击杀 ${names[j] || "?"} ${count} 次`;
          return `<td class="km-cell${count ? " hot" : ""}"${style} title="${escapeHtml(tip)}">${count || ""}</td>`;
        })
        .join("");
      const full = String(names[i] || "未知玩家");
      return `<tr><th class="km-name ${side}" title="${escapeHtml(full)}"><span class="km-who">${av(seatOf(i))}<b>${escapeHtml(full)}</b></span></th>${tds}</tr>`;
    })
    .join("");
  return `<div class="kmatrix-card">
    <div class="km-head"><b>对位击杀</b><span class="dim">行 = 击杀者（左侧是完整游戏 ID）· 列 = 被他击杀的对手（头像，序号与左侧行一一对应）· 格内数字 = 击杀次数</span></div>
    <div class="km-scroll"><table class="kmatrix">
      <thead><tr><th class="km-corner"></th>${colHead}</tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </div>`;
}

function bindMatchTabs(root) {
  const host = root || document;
  const buttons = Array.from(host.querySelectorAll(".match-tabs .mtab"));
  if (!buttons.length) return;
  const panes = Array.from(host.querySelectorAll(".match-pane"));
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      buttons.forEach((el) => el.classList.toggle("on", el === btn));
      const want = btn.dataset.tab;
      panes.forEach((pane) => {
        pane.classList.toggle("hidden", pane.dataset.pane !== want);
      });
    });
  });
}

function roundMarkup(rounds) {
  const list = (rounds && rounds.list) || [];
  if (!list.length || !(rounds.count > 0)) return "";
  const chips = list
    .map((r, i) => {
      const cls = r.won === true ? "win" : r.won === false ? "loss" : "draw";
      const side = r.ally_side === "attack" ? "atk" : r.ally_side === "defense" ? "def" : "";
      const mark = r.ally_side_cn ? `<em>${escapeHtml(r.ally_side_cn.slice(0, 1))}</em>` : "";
      const tip = `第 ${r.n} 回合${r.ally_side_cn ? " · 我方" + r.ally_side_cn : ""}${r.why ? " · " + r.why : ""}`;
      return `<button class="rc ${cls} ${side}" data-i="${i}" title="${escapeHtml(tip)}"><b>${r.n}</b>${mark}</button>`;
    })
    .join("");
  const teamCls = String(rounds.ally_team || "").toLowerCase() === "red" ? "red" : "blue";
  const halves = rounds.first_half_side_cn
    ? `<span class="rh-side">我方 <b class="team-tag ${teamCls}">${escapeHtml(rounds.ally_team_cn || "蓝队")}</b> · 上半场 ${escapeHtml(rounds.first_half_side_cn)} · 下半场 ${escapeHtml(rounds.second_half_side_cn || "")}</span>`
    : "";
  return `<div class="rounds-card">
    <div class="rounds-head">
      <b>回合走势</b>
      <span class="rs-score"><i class="win">${rounds.ally_won}</i> : <i class="loss">${rounds.enemy_won}</i></span>
      ${halves}
      <span class="dim">点回合看首杀与击杀时间线</span>
    </div>
    <div class="round-strip">${chips}</div>
    <div class="round-detail"></div>
  </div>`;
}

function bindRounds(root, payloadArg) {
  const host = root || document;
  const payload = payloadArg || state.matchPayload || {};
  const list = (payload.rounds && payload.rounds.list) || [];
  const strip = host.querySelector(".round-strip");
  const box = host.querySelector(".round-detail");
  if (!strip || !list.length) {
    if (box) box.innerHTML = "";
    return;
  }
  const buttons = Array.from(strip.querySelectorAll(".rc"));
  const show = (index) => {
    buttons.forEach((el, i) => el.classList.toggle("sel", i === index));
    if (box) box.innerHTML = roundDetail(list[index] || {}, payload, index);
  };
  buttons.forEach((el, i) => el.addEventListener("click", () => show(i)));
  const firstLoss = list.findIndex((r) => r.won === false);
  show(list.length > 1 ? Math.max(0, firstLoss) : 0);
}

function roundScore(rounds, index) {
  let ally = 0;
  let enemy = 0;
  ((rounds && rounds.list) || []).slice(0, index + 1).forEach((row) => {
    if (row.won === true) ally += 1;
    else if (row.won === false) enemy += 1;
  });
  return { ally, enemy };
}

function guns(list) {
  const rows = (list || [])
    .map((g) => `<em title="${escapeHtml(g.name)}">${escapeHtml(g.name)}<i>×${g.count}</i></em>`)
    .join("");
  return rows ? `<span class="guns">${rows}</span>` : "";
}

function peopleTable(round) {
  const rows = round.players || [];
  if (!rows.length) return "";
  const cell = (row) => {
    const face = row.agent_icon
      ? `<img class="ag" src="${img(row.agent_icon)}" alt="${escapeHtml(row.agent || "")}" title="${escapeHtml(row.agent || "")}" loading="lazy" />`
      : `<span class="ag blank"></span>`;
    const armor = row.armor_icon
      ? `<img class="armor" src="${img(row.armor_icon)}" alt="" title="${escapeHtml(row.armor || "")}" loading="lazy" />`
      : row.armor
        ? `<em class="armor t">${escapeHtml(row.armor)}</em>`
        : "";
    return `<li class="${row.ally === false ? "enemy" : "ally"}${row.me ? " me" : ""}">
      ${face}
      <span class="who"><b>${escapeHtml(row.name || "—")}</b><em>${escapeHtml(row.agent || "")}</em></span>
      <span class="num k" title="击杀 ${row.kills}">${row.kills}</span>
      <span class="num d" title="伤害 ${row.damage}">${row.damage}</span>
      <span class="num a" title="助攻 ${row.assists}">${row.assists}</span>
      ${armor}
    </li>`;
  };
  const ally = rows.filter((row) => row.ally !== false);
  const enemy = rows.filter((row) => row.ally === false);
  return `<div class="rd-people">
    <div class="rp-side"><h6>我方</h6><ul>${ally.map(cell).join("")}</ul></div>
    <div class="rp-side"><h6>对方</h6><ul>${enemy.map(cell).join("")}</ul></div>
    <p class="rp-legend">K 击杀 · D 伤害 · A 助攻</p>
  </div>`;
}


function killSeconds(text) {
  const m = String(text || "").match(/(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}

function killTimeline(round) {
  const kills = (round.kills || []).filter((k) => Number.isFinite(killSeconds(k.t)));
  if (kills.length < 2) return "";
  const dots = kills
    .map((k) => {
      const sec = killSeconds(k.t);
      const pct = Math.max(0, Math.min(100, (sec / 100) * 100));
      const cls = k.ally === true ? "ally" : k.ally === false ? "enemy" : "";
      const tip = `${k.t || ""} ${k.by || "?"}${k.weapon ? ` [${k.weapon}]` : ""} → ${k.on || "?"}`;
      return `<i class="rdtl-dot ${cls}" style="left:${pct.toFixed(1)}%" title="${escapeHtml(tip)}"></i>`;
    })
    .join("");
  return `<div class="rd-timeline" aria-label="回合击杀时间线"><span class="rdtl-axis"></span>${dots}<span class="rdtl-end">0:00</span><span class="rdtl-end right">1:40</span></div>`;
}
function roundDetail(round, payload, index = 0) {
  if (!round || !round.n) return "";
  const allyEcon = Number(round.ally_econ || 0);
  const enemyEcon = Number(round.enemy_econ || 0);
  const peak = Math.max(allyEcon, enemyEcon, 1);
  const fb = round.first_blood;
  const fbText = fb ? `首杀 ${escapeHtml(fb.name || "")}${fb.agent ? `（${escapeHtml(fb.agent)}）` : ""}` : "本回合无首杀";
  const extra = [round.why, round.site ? `${round.site} 点` : "", round.planted ? "已下包" : "", round.defused ? "已拆包" : ""]
    .filter(Boolean)
    .join(" · ");
  const kills = (round.kills || [])
    .map((kill) => {
      const cls = kill.ally === true ? "ally" : kill.ally === false ? "enemy" : "";
      const weapon = kill.weapon_icon
        ? `<img src="${img(kill.weapon_icon)}" alt="" title="${escapeHtml(kill.weapon || "")}" loading="lazy" />`
        : `<span class="wtext">${escapeHtml(kill.weapon || "")}</span>`;
      const multi = kill.multi ? `<b class="multi">${escapeHtml(kill.multi)}</b>` : "";
      const helpers = (kill.assist_list || [])
        .map((h) => {
          const face = h.icon
            ? `<img src="${img(h.icon)}" alt="" title="助攻 ${escapeHtml(h.name || h.agent || "")}" loading="lazy" />`
            : "";
          return `<span class="helper" title="助攻 ${escapeHtml(h.name || h.agent || "")}"><i class="hb">助</i>${face}</span>`;
        })
        .join("");
      const byFace = kill.by_icon ? `<img class="ka" src="${img(kill.by_icon)}" alt="" loading="lazy" />` : "";
      const onFace = kill.on_icon ? `<img class="ka" src="${img(kill.on_icon)}" alt="" loading="lazy" />` : "";
      return `<li class="${cls}">
        <span class="no">${kill.no || ""}</span>
        <span class="t">${kill.t || ""}</span>
        <span class="by">${byFace}<span class="kn">${escapeHtml(kill.by || "—")}</span>${multi}</span>
        <span class="wpn">${weapon}</span>
        <span class="on"><span class="kn">${escapeHtml(kill.on || "—")}</span>${onFace}${helpers}</span>
      </li>`;
    })
    .join("");
  const info = (payload && payload.rounds) || {};
  const score = roundScore(info, index);
  const side = round.ally_side_cn
    ? `<span class="side-chip ${round.ally_side === "attack" ? "atk" : "def"}">我方${escapeHtml(round.ally_side_cn)}</span>`
    : "";
  const teamCls = String(info.ally_team || "").toLowerCase() === "red" ? "red" : "blue";
  const board = `<span class="rd-score"><b class="team-tag ${teamCls}">${escapeHtml(info.ally_team_cn || "")}</b> ${score.ally} : ${score.enemy} <b class="team-tag ${teamCls === "blue" ? "red" : "blue"}">${escapeHtml(info.enemy_team_cn || "")}</b></span>`;
  return `<div class="rd-head">
      <b>第 ${round.n} 回合</b>
      ${side}
      ${board}
      <span class="rd-why ${round.won === true ? "win" : round.won === false ? "loss" : ""}">${escapeHtml(extra || "—")}</span>
      <span class="rd-fb">${fbText}</span>
    </div>
    ${killTimeline(round)}
    <div class="rd-econ">
      <div class="econ ally"><span>我方经济</span><b>${allyEcon.toLocaleString()}</b>${guns(round.ally_weapons)}<i style="width:${Math.round((allyEcon / peak) * 100)}%"></i></div>
      <div class="econ enemy"><span>对方经济</span><b>${enemyEcon.toLocaleString()}</b>${guns(round.enemy_weapons)}<i style="width:${Math.round((enemyEcon / peak) * 100)}%"></i></div>
    </div>
    ${peopleTable(round)}
    <ul class="rd-kills">${kills || '<li class="dim">这一回合没有击杀记录</li>'}</ul>`;
}

async function loadParty() {
  setBusy(true, "正在统计组队");
  try {
  const __t = $("#party-rows");
  if (__t) __t.innerHTML = skeleton(5);

  clearError();
  bindPartySearch();
  try {
    const data = await api.get("/api/party", { keyword: state.keyword, mode: state.source });
    state.partyData = data;
    renderParty();
  } catch (err) {
    showError(`组队加载失败：${err.message}`);
  }

  } finally {
    setBusy(false);
  }
}

let partySearchTimer = 0;

// 组队页搜索：只在已经拉回来的这批场次里筛，不打新请求。
function bindPartySearch() {
  const input = $("#party-search");
  if (!input || input.dataset.bound) return;
  input.dataset.bound = "1";
  input.addEventListener("input", () => {
    window.clearTimeout(partySearchTimer);
    partySearchTimer = window.setTimeout(renderParty, 150);
  });
}

function partyHit(row, q) {
  if (!q) return true;
  const needle = String(q).toLowerCase();
  const bare = needle.replace(/#/g, "").replace(/\s+/g, "");
  if (!bare) return true;
  return (row.partners || []).some((mate) => {
    const name = String(mate.name || "").toLowerCase();       // 形如「江晚吟#12345」
    const flat = name.replace(/[#\s]/g, "");                  // 「江晚吟12345」
    // 命中三种写法：整串 / 忽略 # 与空格（含只输编号）/ puuid
    return name.includes(needle) || (bare && flat.includes(bare)) || String(mate.subject || "").toLowerCase().includes(needle);
  });
}

function renderParty() {
  const data = state.partyData;
  if (!data) return;
  const input = $("#party-search");
  const q = String((input && input.value) || "").trim().toLowerCase();
  const allRows = data.rows || [];
  const rows = allRows.filter((row) => partyHit(row, q));
  const hint = $("#party-search-hint");
  if (hint) hint.textContent = q ? `筛出 ${rows.length} 场` : "全部队友";

  const metaEl = $("#party-meta");
  if (metaEl) {
    metaEl.textContent = q
      ? `在最近 ${allRows.length} 场里筛出 ${rows.length} 场和「${(input && input.value) || ""}」一起排的`
      : `可分析 ${data.scanned || 0} 场 · 其中 ${data.party_matches || 0} 场组队（${data.party_rate || 0}%）· 下面展示最近 ${allRows.length} 场`;
  }

  // 筛人后分布/队友榜都只按筛出来的场次重算
  const pnote = $("#party-note");
  if (pnote) {
    pnote.textContent = data.note || "";
    pnote.classList.toggle("hidden", !data.note);
  }
  const pool = q ? rows : allRows;
  const distribution = {};
  pool.forEach((row) => {
    const size = String(row.party || 1);
    distribution[size] = (distribution[size] || 0) + 1;
  });
  const entries = Object.entries(distribution).sort((a, b) => Number(a[0]) - Number(b[0]));
  const max = Math.max(1, ...entries.map(([, v]) => v));
  $("#party-bars").innerHTML = entries.length
    ? entries.map(([size, count]) => `
        <div class="bar-row">
          <span>${size} 人组队</span>
          <span class="bar"><i style="width:${Math.round((count / max) * 100)}%"></i></span>
          <span>${count} 场</span>
        </div>`).join("")
    : '<p class="dim">没有组队记录。</p>';

  let mates = data.teammates || [];
  if (q) {
    const tally = new Map();
    rows.forEach((row) => (row.partners || []).forEach((mate) => {
      const key = mate.subject || mate.name || "";
      const bucket = tally.get(key) || { name: mate.name || "?", n: 0 };
      bucket.n += 1;
      tally.set(key, bucket);
    }));
    mates = Array.from(tally.values()).sort((a, b) => b.n - a.n).slice(0, 8);
  }
  $("#party-mates").innerHTML = mates
    .map((m) => {
      const letter = escapeHtml((m.name || "?").slice(0, 1));
      const av = m.avatar ? `<img class="mate-av" src="${img(m.avatar)}" alt="" loading="lazy" onerror="this.remove()" />` : "";
      // data-name 必须是完整的「昵称#编号」：只回填前缀的话，筛选条件会丢掉编号
      return `<button type="button" class="mate" data-name="${escapeHtml(String(m.name || ""))}" title="${escapeHtml(String(m.name || ""))}"><span class="av${m.avatar ? " has" : ""}">${letter}${av}</span><span class="mate-name">${escapeHtml(m.name)}</span><b>${m.n} 场</b></button>`;
    })
    .join("") || '<p class="dim">队友统计需要 PD 详情，当前无法计算。</p>';
  $$("#party-mates .mate").forEach((el) => {
    el.addEventListener("click", () => {
      if (!input) return;
      input.value = el.dataset.name || "";  // 带编号整串回填
      renderParty();
    });
  });

  const rowsEl = $("#party-rows");
  rowsEl.innerHTML = rows.length
    ? rows.map(rowHtml).join("")
    : `<p class="dim">最近 ${allRows.length} 场里没有和这位玩家一起排的对局。</p>`;
  $$("#party-rows .row").forEach((el) => {
    el.addEventListener("click", (ev) => {
      ev.preventDefault();
      loadMatch(el.dataset.match, null);
    });
  });
}

async function loadAssets() {
  setBusy(true, "正在读取资产");
  try {
  const __t = $("#asset-skins");
  if (__t) __t.innerHTML = skeleton(4);

  clearError();
  try {
    const frags = [];
    $("#assets-meta").textContent = "加载中…";
    const data = await api.get("/api/player/assets", { keyword: state.keyword, mode: state.source });
    if (data.unavailable) {
      // 掌瓦没收录这个账号 → 拿不到他本人的 scene，ACLOS 只会回请求者自己的资产。
      // 后端现在会直接标记 unavailable，这里给提示，不要画成别人的图。
      setBusy(false);
      $("#assets-meta").textContent = "";
      $("#asset-counts").innerHTML = "";
      const who = state.player || {};
      const hasNum = Boolean(who.app_num);
      const bindBtn = hasNum
        ? ""
        : `<button type="button" class="bind-btn" id="assets-bind">填他的掌瓦号</button>`;
      $("#asset-skins").innerHTML = `<p class="empty">${escapeHtml(data.reason || "这个账号的资产暂时查不到")}</p>
        <p class="empty">${hasNum
          ? "掌瓦那边没有这个账号的档案（号存在，但没绑过端游 / 资料卡是空的），所以拿不到他本人的资产。"
          : "掌瓦的搜索索引是按掌瓦昵称建的，所以只凭游戏ID查不到他的掌瓦号。知道他的 9 位掌瓦号的话，填一次就能查了；以后这个ID都会记住。"}</p>
        ${bindBtn}`;
      const bind = $("#assets-bind");
      if (bind) {
        bind.addEventListener("click", async () => {
          await bindAppNum({ ...who, label: who.label || state.keyword });
          await loadAssets();
        });
      }
      return;
    }
    const counts = data.counts || {};
    $("#assets-meta").textContent = counts.guns ? `库里 ${counts.guns} 把枪` : "";
    const vp = Number(String(counts.cost_num || "0").replace(/[^\d.]/g, "")) || 0;
    const rp = Number(String(counts.r_num || "0").replace(/[^\d.]/g, "")) || 0;
    $("#asset-counts").innerHTML = [
      ["枪皮", counts.skins], ["卡面", counts.cards], ["喷漆", counts.sprays],
      ["挂饰", counts.charms], ["英雄", `${counts.agents ?? 0}/${counts.agents_total ?? 0}`],
      ["枪械", counts.guns],
      ["已花费 VP", vp.toLocaleString("en-US")], ["已消耗 R 点", rp.toLocaleString("en-US")],
    ].map(([k, v]) => `<div class="count"><div class="k">${k}</div><div class="v">${v ?? 0}</div></div>`).join("");

    const card = (item, sub) => `
      <div class="asset">
        <img src="${img(item.icon)}" alt="" />
        <span>${item.name || "—"}</span>
        ${sub ? `<em>${sub}</em>` : ""}
      </div>`;
    state.assetData = data;
    renderSkins();
    renderAssetGrids(data, card);
  } catch (err) {
    showError(`资产加载失败：${err.message}`);
  }

  } finally {
    setBusy(false);
  }
}


let socialCache = null;

function fmtDay(ts) {
  if (!ts) return "—";
  const seconds = Number(ts) > 1e11 ? Number(ts) / 1000 : Number(ts); // 兼容毫秒老缓存
  const d = new Date(seconds * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function loadSocial(force = false) {
  setBusy(true, "正在扫描组队");
  try {
  const __t = $("#social-people");
  if (__t) __t.innerHTML = skeleton(5);

  clearError();
  if (!state.keyword) return;
  if (!socialCache || force || socialCache.for !== state.keyword) {
    $("#social-meta").textContent = "扫描最近对局…";
    try {
      socialCache = await api.get("/api/player/social", { keyword: state.keyword, limit: 50, mode: state.source });
      socialCache.for = state.keyword;
    } catch (err) {
      showError(`好友与组队加载失败：${err.message}`);
      return;
    }
  }
  renderPeople();
  syncSummaryMates();

  } finally {
    setBusy(false);
  }
}

// 一个月以上的「最近开黑」不再显示
const REL_LIMIT = 30 * 86400;

function fullDate(seconds) {
  const ts = Number(seconds || 0);
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function stampText(seconds) {
  const ts = Number(seconds || 0);
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, "0");
  const md = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  return d.getFullYear() === new Date().getFullYear() ? md : `${d.getFullYear()}-${md}`;
}

function relTime(seconds) {
  const ts = Number(seconds || 0);
  if (!ts) return "";
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (diff > REL_LIMIT) return "";
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  const days = Math.floor(diff / 86400);
  return days <= 1 ? "昨天" : `${days} 天前`;
}

function personCard(p) {
  const ago = relTime(p.last);
  return `
    <article class="person">
      <div class="person-avatar${p.avatar ? " has" : ""}"><span>${(p.name || "?").slice(0, 1)}</span>${p.avatar ? `<img src="${img(p.avatar)}" alt="" loading="lazy" onerror="this.remove()" />` : ""}</div>
      <div class="person-main">
        <b>${escapeHtml(p.name)}</b>
        <span>${p.group} · 上次组排 ${fullDate(p.last)}${ago ? `（${ago}）` : ""}</span>
      </div>
      <div class="person-stat"><b>${p.games}</b><span>场</span></div>
      <div class="person-stat"><b>${p.win_rate}<small>%</small></b><span>胜率</span></div>
      <div class="person-agents">${(p.agents || []).map((a) => `<i>${escapeHtml(a)}</i>`).join("")}</div>
    </article>`;
}

function renderPeople() {
  const data = socialCache;
  if (!data) return;
  const keyword = ($("#social-filter").value || "").trim();
  const group = state.socialGroup;

  // 只保留一个月内一起排过的人，按最近同排时间倒序
  const fresh = (list, label) =>
    (list || [])
      .filter((p) => relTime(p.last))
      .map((p) => ({ ...p, group: label }))
      .sort((a, b) => (Number(b.last) || 0) - (Number(a.last) || 0));
  const friends = fresh(data.friends, "好友");
  const strangers = fresh(data.strangers, "组排非好友");

  const hit = (list) => (keyword ? list.filter((p) => (p.name || "").includes(keyword)) : list);

  const friendTotal = data.friend_total || (data.friends_list || []).length || 0;
  $("#social-meta").textContent =
    `好友 ${friendTotal} 人 · 近一个月一起排过：好友 ${friends.length} 人 / 非好友 ${strangers.length} 人 · 扫描 ${data.scanned || 0} 场（可判定 ${data.matched || 0} 场）`
    + (data.friend_source === "self" ? " · 好友名单回退为你自己的" : "");

  const strip = $("#social-friends");
  if (strip) {
    const playedMap = new Map((data.friends || []).map((p) => [p.subject, p.last]));
    const list = data.friends_list || [];
    strip.innerHTML = list.length
      ? `<span class="strip-label">全部好友名单 ${list.length} 人</span>`
        + list
            .map((f) => {
              const last = playedMap.get(f.subject);
              const ago = last ? relTime(last) : "";
              const hot = !!ago;
              const tip = hot ? `最近同排 ${fullDate(last)}（${ago}）` : `近一个月没有一起排过`;
              const fav = f.avatar ? `<img class="fchip-av" src="${img(f.avatar)}" alt="" loading="lazy" onerror="this.remove()" />` : `<i class="fchip-av none">${escapeHtml(String(f.name || "?").slice(0, 1))}</i>`;
              return `<span class="fchip${hot ? " hot" : ""}" title="${escapeHtml(f.name)} · ${tip}">${fav}${escapeHtml(f.name)}${
                hot ? `<em class="hot-tag">近期同排</em>` : ""
              }</span>`;
            })
            .join("")
      : '<span class="strip-label">没有拿到好友名单</span>';
  }

  const blocks = [];
  if (group !== "strangers") {
    blocks.push(`
      <section class="people-block">
        <h4>好友组排 <span>${friends.length}</span></h4>
        <div class="people">${hit(friends).map(personCard).join("") || '<p class="dim">近一个月没有和好友组排。</p>'}</div>
      </section>`);
  }
  if (group !== "friends") {
    blocks.push(`
      <section class="people-block">
        <h4>非好友组排 <span>${strangers.length}</span></h4>
        <div class="people">${hit(strangers).map(personCard).join("") || '<p class="dim">近一个月没有和非好友组排。</p>'}</div>
      </section>`);
  }
  $("#social-people").innerHTML = blocks.join("");
}

async function loadSeason() {
  setBusy(true, "正在生成总览");
  try {
  const __t = $("#radar");
  if (__t) __t.innerHTML = skeleton(0);

  if (!state.player) return;
  try {
    const [data, official] = await Promise.all([
      api.get("/api/player/season", { keyword: state.keyword, mode: state.source }),
      api.get("/api/player/career", { keyword: state.keyword, mode: state.source }).catch(() => null),
    ]);
    state.seasonData = data;
    officialState.base = official;
    officialState.acts = {};
    officialState.act = "";
    renderSeason(data);
    renderDataMeta(data.meta);
  } catch (err) {
    showError(err.message);
  }

  } finally {
    setBusy(false);
  }
}

function radarSvg(axes) {
  const size = 300;
  const c = size / 2;
  const r = 112;
  const n = axes.length || 1;
  const pt = (i, ratio) => {
    const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
    return [c + Math.cos(angle) * r * ratio, c + Math.sin(angle) * r * ratio];
  };
  const rings = [0.25, 0.5, 0.75, 1]
    .map((k) => {
      const points = axes.map((_, i) => pt(i, k).join(",")).join(" ");
      return `<polygon points="${points}" class="ring" />`;
    })
    .join("");
  const spokes = axes
    .map((_, i) => {
      const [x, y] = pt(i, 1);
      return `<line x1="${c}" y1="${c}" x2="${x}" y2="${y}" class="spoke" />`;
    })
    .join("");
  const shape = axes
    .map((axis, i) => {
      const ratio = Math.max(0.06, Math.min(1, (Number(axis.value) || 0) / (Number(axis.max) || 100)));
      return pt(i, ratio).join(",");
    })
    .join(" ");
  const labels = axes
    .map((axis, i) => {
      const [x, y] = pt(i, 1.24);
      return `<text x="${x}" y="${y}" class="axis">${escapeHtml(axis.name)}</text>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${size} ${size}" class="radar-svg">${rings}${spokes}<polygon points="${shape}" class="value" />${labels}</svg>`;
}

/**
 * 近期段位走势：拿历史行的每局 RR 增减，从当前分数往回推每局结束后的分数。
 * rows 是新→旧，所以倒着累加：越旧的场次，减掉的增量越多。
 */
function rankTrendSvg(rows, rank) {
  const all = (rows || []).filter((row) => row && row.rr != null && String(row.mode || "") === "competitive");
  if (all.length < 2) return null;
  const newestFirst = all.slice(0, 20);
  const current = rank && rank.rr ? Number(rank.rr) : null;
  const deltas = newestFirst.map((row) => Number(row.rr) || 0);
  // 最新一场打完的分数 = 当前分数；再往前推就是从当前分数里减掉之后每场的增量
  const seq = [];
  let prefix = 0;
  for (let k = 0; k < newestFirst.length; k += 1) {
    const row = newestFirst[k];
    seq.push({
      row,
      after: Math.max(0, current == null ? -prefix : current - prefix),
      delta: deltas[k],
      win: Boolean(row.win),
      tier: Number(row.tier_after) || 0,
      tierName: String(row.tier_after_name || ""),
      label: shortDate(row.start_time || row.time || ""),
    });
    prefix += deltas[k];
  }
  const points = seq.reverse(); // 旧 → 新
  // 段位每升一档 RR 会清零，所以纵向按「段位档位 + 段内 RR」画阶梯，纵轴直接标段位名
  const withTier = points.filter((p) => p.tier > 0);
  const useTier = withTier.length >= 2;
  const tiers = withTier.map((p) => p.tier);
  const tierLow = useTier ? Math.min(...tiers) : 0;
  const tierHigh = useTier ? Math.max(...tiers) : 0;
  const tierNames = new Map();
  withTier.forEach((p) => {
    if (p.tierName && !tierNames.has(p.tier)) tierNames.set(p.tier, p.tierName);
  });
  const valueOf = (p) => {
    if (!useTier) return p.after;
    const inTier = Math.min(99, Math.max(0, p.after));
    return (p.tier || tierLow) - tierLow + inTier / 100;
  };
  const values = points.map(valueOf);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pad = useTier ? 0.12 : Math.max(6, Math.round((hi - lo) * 0.18));
  const min = useTier ? lo - pad : lo - pad;
  const max = useTier ? tierHigh - tierLow + 1 : hi + pad;
  const W = 760;
  const H = 210;
  const L = 46;
  const R = 16;
  const T = 16;
  const B = 30;
  const innerW = W - L - R;
  const innerH = H - T - B;
  const x = (i) => L + (points.length === 1 ? innerW / 2 : (innerW * i) / (points.length - 1));
  const y = (v) => T + innerH - ((v - min) / Math.max(1, max - min)) * innerH;
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(valueOf(p)).toFixed(1)}`).join(" ");
  const area = `${line} L${x(points.length - 1).toFixed(1)},${(T + innerH).toFixed(1)} L${L},${(T + innerH).toFixed(1)} Z`;
  const dots = points
    .map((p, i) => {
      const cls = p.win ? "win" : "loss";
      const title = `${p.label} · ${p.row.tier_after_name || "定级"} ${p.after} 分（${p.delta > 0 ? "+" : ""}${p.delta}）`;
      return `<circle class="dot ${cls}" cx="${x(i).toFixed(1)}" cy="${y(valueOf(p)).toFixed(1)}" r="4.5"><title>${escapeHtml(title)}</title></circle>`;
    })
    .join("");
  const tickList = useTier
    ? [...new Set(withTier.map((p) => p.tier))].sort((a, b) => a - b).map((tier) => ({
        value: tier - tierLow,
        text: tierNames.get(tier) || `段位 ${tier}`,
        strong: true,
      }))
    : [0, 0.5, 1].map((ratio) => ({
        value: Math.round(min + (max - min) * ratio),
        text: String(Math.round(min + (max - min) * ratio)),
        strong: false,
      }));
  const ticks = tickList
    .map((t) => {
      const ty = y(t.value).toFixed(1);
      return `<line class="grid${t.strong ? " tier" : ""}" x1="${L}" x2="${W - R}" y1="${ty}" y2="${ty}" /><text class="tick${t.strong ? " tier" : ""}" x="${L - 8}" y="${ty}" dy="3.5">${escapeHtml(t.text)}</text>`;
    })
    .join("");
  const labels = points
    .map((p, i) =>
      i === 0 || i === points.length - 1 || i === Math.floor(points.length / 2)
        ? `<text class="xlab" x="${x(i).toFixed(1)}" y="${H - 8}">${escapeHtml(p.label)}</text>`
        : "",
    )
    .join("");
  // 段位变化标注：只在段位真的变了的那一场标注名字（图标 + 文字）
  const marks = [];
  let prevTier = null;
  points.forEach((p, i) => {
    const tier = Number(p.row.tier_after) || 0;
    const name = String(p.row.tier_after_name || "");
    if (!tier || !name) return;
    if (prevTier !== null && tier === prevTier) return;
    prevTier = tier;
    marks.push({ i, tier, name, icon: String(p.row.tier_after_icon || "") });
  });
  // 段位变化次数通常不多（一局升一段也就几次），全部标出来，相邻的上下错开
  const kept = marks.length > 6 ? marks.slice(-6) : marks;
  const tierMarks = kept
    .map((m, pos) => {
      const px = x(m.i);
      const py = y(valueOf(points[m.i]));
      // 相邻两个标注上下错开，避免挤在一起
      const above = pos % 2 === 0 ? py - T > 52 : py - T <= 52;
      const iconY = above ? py - 40 : Math.min(T + innerH - 26, py + 14);
      const textY = above ? iconY - 6 : iconY + 26;
      const anchor = px > W - R - 46 ? "end" : px < L + 46 ? "start" : "middle";
      const icon = m.icon
        ? `<image href="${escapeHtml(m.icon)}" x="${(px - 8).toFixed(1)}" y="${iconY.toFixed(1)}" width="16" height="16" />`
        : "";
      return `${icon}<text class="tierlab" x="${px.toFixed(1)}" y="${textY.toFixed(1)}" text-anchor="${anchor}">${escapeHtml(m.name)}</text>`;
    })
    .join("");
  const chain = marks.map((m) => m.name).filter((name, i, arr) => i === 0 || name !== arr[i - 1]);
  const last = points[points.length - 1];
  const first = points[0];
  const total = deltas.reduce((sum, d) => sum + d, 0);
  const diff = current == null ? total : total;
  return {
    svg: `<svg class="trend" viewBox="0 0 ${W} ${H}" role="img" aria-label="近期段位走势">
      <defs><linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#16866a" stop-opacity="0.26" />
        <stop offset="100%" stop-color="#16866a" stop-opacity="0" />
      </linearGradient></defs>
      ${ticks}
      <path class="area" d="${area}" />
      <path class="line" d="${line}" />
      ${dots}${tierMarks}${labels}
    </svg>`,
    sub: `${chain.length > 1 ? `${chain.join(" → ")} · ` : ""}${points.length} 场竞技 · 累计 ${
      diff >= 0 ? "+" : ""
    }${diff} 分${current == null ? "" : ` · 当前 ${last.after} 分`}`,
  };
}

// ---- 官方生涯（掌瓦 career/seasonoverview）---------------------------------
const officialState = { base: null, acts: {}, act: "" };

function officialTiles(data) {
  const rank = (data && data.rank) || {};
  const stats = (data && data.stats) || {};
  const items = [
    ["当前段位", rank.current || "—"],
    ["赛季最高", rank.peak || "—"],
    ["近期表现", rank.recent || "—"],
    ["胜率", stats.win_rate ? `${stats.win_rate}%` : "—"],
    ["表现评分", stats.perf || "—"],
    ["KAST", stats.kast || "—"],
    ["总时长", stats.time || "—"],
  ];
  return items
    .map(([k, v]) => `<div class="career-tile"><span>${k}</span><b>${escapeHtml(String(v))}</b></div>`)
    .join("");
}

function officialSpark(trend) {
  const values = (trend || []).slice(-30).filter((v) => Number.isFinite(v));
  if (values.length < 2) return "";
  const w = 260;
  const h = 46;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const points = values
    .map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - 4 - ((v - min) / span) * (h - 8)).toFixed(1)}`)
    .join(" ");
  return `<svg class="career-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-label="段位趋势"><polyline points="${points}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" /></svg>`;
}

function officialHtml() {
  const base = officialState.base;
  if (!base) return "";
  if (!base.ok) {
    return `<p class="muted official-note">掌瓦生涯数据不可用：${escapeHtml(base.reason || "未知原因")}；下面是用已拉到的对局算的本地统计。</p>`;
  }
  const view = officialState.acts[officialState.act] || base;
  const current = (base.seasons || []).find((s) => s.key === officialState.act);
  const seasons = (base.seasons || []).filter((s) => s.key !== "255");
  const chips = [`<button class="act-chip${officialState.act === "" ? " on" : ""}" data-act="">当前赛幕</button>`]
    .concat(
      seasons.map(
        (s) =>
          `<button class="act-chip${officialState.act === s.key ? " on" : ""}" data-act="${escapeHtml(s.key)}">${escapeHtml(s.title)}</button>`,
      ),
    )
    .join("");
  return `<div class="career-official">
      <div class="career-head"><b>官方生涯</b><span class="muted">掌瓦口径 · ${escapeHtml(current ? current.title : "当前赛幕")}</span></div>
      <div class="career-strip">${officialTiles(view)}</div>
      ${officialSpark(view.trend)}
      ${!current && view.stats && !view.stats.win_rate ? `<p class="muted official-note">掌瓦对每个赛幕只公开段位与趋势，历史赛幕的胜率 / 评分不对外；要看胜率请用下面的本地生涯统计。</p>` : ""}
      ${seasons.length ? `<div class="act-chips">${chips}</div>` : ""}
    </div>`;
}

async function loadCareerAct(key) {
  if (!officialState.base || !officialState.base.ok) return;
  if (key && !officialState.acts[key]) {
    setBusy(true, "正在读取赛幕");
    try {
      const data = await api.get("/api/player/career", {
        keyword: state.keyword,
        mode: state.source,
        season: key,
      });
      officialState.acts[key] = data;
    } catch (err) {
      showError(err.message);
      return;
    } finally {
      setBusy(false);
    }
  }
  officialState.act = key;
  if (state.seasonData) renderSeason(state.seasonData);
}

function renderSeason(data) {
  if (!data || !data.player) return;
  const axes = (data.radar || []).slice(0, 8);
  $("#radar").innerHTML = axes.length ? radarSvg(axes) : '<p class="muted">暂无能力数据</p>';
  $("#radar-note").textContent = `${data.sample || 0} 场样本 · 能力值来自个人生涯数据`;
  $("#season-sub").textContent = `${data.sample || 0} 场样本`;

  const rows = (data.modes || [])
    .map(
      (m) => `<tr><td>${escapeHtml(m.mode_name || m.mode)}</td><td>${m.matches}</td><td>${m.win_rate}%</td><td>${m.kd}</td><td>${m.acs}</td></tr>`,
    )
    .join("");
  $("#mode-table").innerHTML = rows
    ? `<table class="board"><thead><tr><th>模式</th><th>场次</th><th>胜率</th><th>K/D</th><th>ACS</th></tr></thead><tbody>${rows}</tbody></table>`
    : "";

  const list = (items) =>
    (items || [])
      .map(
        (it) => `<div class="mini"><span>${escapeHtml(it.name)}</span><b>${it.n} 场</b><i>${it.win_rate}%</i></div>`,
      )
      .join("");
  $("#season-agents").innerHTML = list(data.agents) || '<p class="muted">—</p>';
  $("#season-maps").innerHTML = list(data.maps) || '<p class="muted">—</p>';

  const career = data.career || null;
  const careerBox = $("#season-career");
  if (careerBox) {
    const official = officialHtml();
    if (!career) {
      careerBox.innerHTML = official;
    } else {
      const tiles = [
        ["场次", career.matches],
        ["胜率", `${career.win_rate}%`],
        ["K/D", career.kd],
        ["KDA", career.kda],
        ["ACS", career.acs],
        ["常用", career.agent || "—"],
      ]
        .map(([k, v]) => `<div class="career-tile"><span>${k}</span><b>${escapeHtml(String(v))}</b></div>`)
        .join("");
      careerBox.innerHTML = `${official}<div class="career-strip">${tiles}</div><p class="muted">${escapeHtml(career.note || "")}</p>`;
    }
  }
  const actsBox = $("#season-acts");
  if (actsBox) {
    const acts = data.acts || [];
    actsBox.innerHTML = acts.length
      ? `<table class="board"><thead><tr><th>赛幕</th><th>时间</th><th>场次</th><th>胜率</th><th>K/D</th><th>ACS</th><th>常用英雄</th></tr></thead><tbody>${acts
          .map(
            (a) =>
              `<tr><td>${escapeHtml(a.act)}</td><td class="muted">${escapeHtml(a.first)} ~ ${escapeHtml(a.last)}</td><td>${a.matches}</td><td>${a.win_rate}%</td><td>${a.kd}</td><td>${a.acs}</td><td>${escapeHtml(a.agent || "—")}</td></tr>`,
          )
          .join("")}</tbody></table>`
      : '<p class="muted">—</p>';
  }

  const trend = rankTrendSvg(state.rows, state.rank);
  const trendBox = $("#season-trend");
  if (trendBox) {
    trendBox.innerHTML = trend ? trend.svg : '<p class="muted">最近几场没有竞技对局，等打几把排位再来看看。</p>';
  }
  const sub = $("#trend-sub");
  if (sub) sub.textContent = trend ? trend.sub : "";
}

function switchTab(name) {
  state.tab = name;
  $$("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  ["history", "match", "party", "assets", "social", "season"].forEach((key) => {
    $(`#panel-${key}`).classList.toggle("hidden", key !== name);
  });
  if (name === "party") loadParty();
  if (name === "assets") loadAssets();
  if (name === "social") loadSocial();
  if (name === "season") loadSeason();
  if (name === "match" && !state.matchId && !state.matchLoaded && state.rows.length) {
    loadMatch(state.rows[0].match_id);
  }
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) checkWatch();
});

async function refreshHealth(force) {
  let health;
  try {
    health = await api.get(`/api/health${force ? "?refresh=1" : ""}`);
  } catch (_) {
    $("#health").textContent = "后端未启动";
    return null;
  }
  renderHealth(health);
  renderCredAlert(health);
  return health;
}

function renderHealth(health) {
  const cred = health.credentials || {};
  const mark = (ok) => (ok ? "<b>●</b>" : "<s>●</s>");
  $("#health").innerHTML = `${mark(cred.pd)}PD ${mark(cred.aclos)}助手 ${mark(cred.wegame)}WG`;
  $("#footer-cred").textContent =
    `战绩 ${cred.pd ? "ready" : "missing"} · 长历史 ${cred.aclos ? "ready" : "missing"} · 名字 ${cred.wegame ? "ready" : "missing"}`;
  renderCredChip(health);
}

/* 顶栏那颗小圆点：只要有登录态挂了就一直亮着（不受「知道了」影响），
   点它直接去登录页，省得每次都要翻红条才知道出了什么事。 */
function renderCredChip(health) {
  const chip = $("#cred-chip");
  if (!chip) return;
  const bad = (health.credential_states || []).filter((s) => s.state !== "ok");
  if (!bad.length) {
    chip.classList.add("hidden");
    chip.textContent = "";
    return;
  }
  const labels = bad.map((s) => s.short || s.label).join("、");
  chip.className = `cred-chip ${bad.some((s) => ["expired", "missing"].includes(s.state)) ? "bad" : "warn"}`;
  chip.textContent = `⚠ ${labels} 待重扫`;
  chip.title = bad
    .map((s) => `${s.label}：${s.state === "expiring" ? "快过期" : "已失效"}${s.since_text ? `（${s.since_text} 起）` : ""}${s.last_ok_text ? ` · 最后正常 ${s.last_ok_text}` : ""}\n${s.message || ""}`)
    .join("\n");
}

/* 「什么过期了」：后端 /api/health 给出每份登录态的具体过期时间与影响，
   这里只负责画出来。不做一键重扫——扫码要人拿手机，按钮点了也没用。 */
function renderCredAlert(health) {
  const box = $("#cred-alert");
  if (!box) return;
  const states = health.credential_states || [];
  const bad = states.filter((s) => s.state !== "ok" && s.message);
  let dismissed = [];
  try {
    dismissed = JSON.parse(sessionStorage.getItem("cred-dismissed") || "[]");
  } catch (_) {
    dismissed = [];
  }
  const shown = bad.filter((s) => !dismissed.includes(`${s.key}:${s.state}`));
  if (!shown.length) {
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }
  const hasExpired = shown.some((s) => s.state === "expired" || s.state === "missing");
  box.className = `cred-alert ${hasExpired ? "bad" : "warn"}`;
  box.innerHTML = `
    <div class="ca-head">
      <strong>${hasExpired ? "有登录态已经过期" : "有登录态快过期了"}</strong>
      <button type="button" class="ca-close" title="本次打开页面不再提示">知道了</button>
    </div>
    <ul>${shown
      .map((s) => {
        const when = [
          s.since_text ? `${s.state === "expiring" ? `预计 ${s.since_text} 过期` : `${s.since_text} 起`}` : "",
          s.last_ok_text ? `最后正常 ${s.last_ok_text}` : "",
        ].filter(Boolean).join(" · ");
        return `<li><b>${escapeHtml(s.label)}</b><span>${escapeHtml(s.message)}</span>${when ? `<em>${escapeHtml(when)}</em>` : ""}</li>`;
      })
      .join("")}</ul>
    <p class="ca-foot">掌瓦数据由服务端统一提供，需要重新扫码时请联系站点管理员。</p>`;
  box.querySelector(".ca-close").addEventListener("click", () => {
    const next = dismissed.concat(shown.map((s) => `${s.key}:${s.state}`));
    sessionStorage.setItem("cred-dismissed", JSON.stringify(next));
    box.classList.add("hidden");
  });
}

// ── 最近查询 / 我的收藏 ────────────────────────────────────────────────
// 只存本地 localStorage，不上传服务器；「记住查询」关掉后就不再往最近列表里写。
const RECENT_KEY = "valo.recentSearches";
const FAV_KEY = "valo.favorites";
const REMEMBER_KEY = "valo.rememberSearch";
const RECENT_LIMIT = 12;
let srTab = "recent";

function readNameList(key) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string" && x.trim()) : [];
  } catch (err) {
    return [];
  }
}

function writeNameList(key, list) {
  try {
    localStorage.setItem(key, JSON.stringify(list.slice(0, 40)));
  } catch (err) {
    /* 隐私模式下 localStorage 会抛，忽略 */
  }
}

function rememberEnabled() {
  try {
    return localStorage.getItem(REMEMBER_KEY) !== "0";
  } catch (err) {
    return true;
  }
}

function rememberSearch(keyword) {
  const key = String(keyword || "").trim();
  if (!key || !rememberEnabled()) return;
  const list = readNameList(RECENT_KEY).filter((item) => item !== key);
  list.unshift(key);
  writeNameList(RECENT_KEY, list.slice(0, RECENT_LIMIT));
}

function toggleFavorite(keyword) {
  const key = String(keyword || "").trim();
  if (!key) return;
  const list = readNameList(FAV_KEY);
  const at = list.indexOf(key);
  if (at >= 0) list.splice(at, 1);
  else list.unshift(key);
  writeNameList(FAV_KEY, list);
  renderSearchHistory();
}

function renderSearchHistory() {
  const box = $("#search-recent");
  if (!box) return;
  const recent = readNameList(RECENT_KEY);
  const favs = readNameList(FAV_KEY);
  if (!recent.length && !favs.length && !state.keyword) {
    box.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");
  $$("#search-recent .sr-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.list === srTab));
  const items = srTab === "fav" ? favs : recent;
  const host = $("#sr-items");
  if (host) {
    host.innerHTML = items.length
      ? items
          .map(
            (name) =>
              `<span class="sr-item"><button type="button" class="sr-go" data-keyword="${escapeHtml(name)}" title="查询 ${escapeHtml(name)}">${escapeHtml(name)}</button><button type="button" class="sr-del" data-keyword="${escapeHtml(name)}" title="删掉" aria-label="删除">×</button></span>`
          )
          .join("")
      : `<span class="dim">${srTab === "fav" ? "还没有收藏：查到人之后点右边的「☆ 收藏」" : "还没有查询记录"}</span>`;
    host.querySelectorAll(".sr-go").forEach((btn) =>
      btn.addEventListener("click", () => {
        const input = $("#search-input");
        if (input) input.value = btn.dataset.keyword;
        loadPlayer(btn.dataset.keyword);
      })
    );
    host.querySelectorAll(".sr-del").forEach((btn) =>
      btn.addEventListener("click", () => {
        const key = srTab === "fav" ? FAV_KEY : RECENT_KEY;
        writeNameList(key, readNameList(key).filter((item) => item !== btn.dataset.keyword));
        renderSearchHistory();
      })
    );
  }
  const favBtn = $("#sr-fav");
  if (favBtn) {
    const saved = Boolean(state.keyword) && favs.includes(state.keyword);
    favBtn.textContent = saved ? "★ 已收藏" : "☆ 收藏";
    favBtn.classList.toggle("on", saved);
    favBtn.disabled = !state.keyword;
  }
  const remember = $("#sr-remember");
  if (remember) remember.checked = rememberEnabled();
}

function initSearchHistory() {
  const box = $("#search-recent");
  if (!box) return;
  $$("#search-recent .sr-tab").forEach((tab) =>
    tab.addEventListener("click", () => {
      srTab = tab.dataset.list === "fav" ? "fav" : "recent";
      renderSearchHistory();
    })
  );
  const remember = $("#sr-remember");
  if (remember)
    remember.addEventListener("change", () => {
      try {
        localStorage.setItem(REMEMBER_KEY, remember.checked ? "1" : "0");
      } catch (err) {
        /* 忽略 */
      }
    });
  const clear = $("#sr-clear");
  if (clear)
    clear.addEventListener("click", () => {
      const target = srTab === "fav" ? FAV_KEY : RECENT_KEY;
      if (!readNameList(target).length) return;
      if (!window.confirm(srTab === "fav" ? "清空收藏？" : "清空最近查询记录？")) return;
      writeNameList(target, []);
      renderSearchHistory();
    });
  const favBtn = $("#sr-fav");
  if (favBtn) favBtn.addEventListener("click", () => toggleFavorite(state.keyword));
  renderSearchHistory();
}

async function boot() {
  await refreshHealth();
  setInterval(() => refreshHealth(true).catch(() => {}), 90000);

  // 单局详情的打开方式（就地快速查看 / 单页完整查看）
  syncOpenModeUI();
  $$("#open-mode button").forEach((btn) =>
    btn.addEventListener("click", () => setOpenMode(btn.dataset.open))
  );
  initSearchHistory();

  $("#search-form").addEventListener("submit", (event) => {
    event.preventDefault();
    // 全角 ＃ / 全角字母数字先归一化，不然「三杆大烟枪＃81799」查不到
    const keyword = $("#search-input").value.normalize("NFKC").replace(/＃/g, "#").trim();
    if (!keyword) return;
    // 「掌瓦ID」模式下粘了带 # 的游戏 ID：掌瓦号永远没有 #，直接切成游戏ID，
    // 按钮状态跟着变，别让人以为是在查掌瓦号。
    if (state.source === "mval" && keyword.includes("#")) {
      $$("#search-mode button").forEach((b) => b.classList.toggle("active", b.dataset.source === "game"));
      state.source = "game";
      $("#search-input").placeholder = "游戏昵称#编号，如 眠是未觉雨#40889";
    }
    loadPlayer(keyword);
  });


  $$("#search-mode button").forEach((btn) => btn.addEventListener("click", () => {
    $$("#search-mode button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.source = btn.dataset.source;
    $("#search-input").placeholder = state.source === "mval"
      ? "掌瓦号，如 011091448 或掌瓦昵称"
      : "游戏昵称#编号，如 眠是未觉雨#40889";
  }));

  $$("#tabs button").forEach((btn) => btn.addEventListener("click", () => switchTab(btn.dataset.tab)));
  const sortBox = $("#asset-sort");
  const orderBtn = $("#asset-order");
  const syncOrder = () => {
    if (orderBtn) {
      orderBtn.textContent = ORDER_LABELS[state.assetOrder] || ORDER_LABELS.desc;
      orderBtn.dataset.order = state.assetOrder;
    }
  };
  if (sortBox) {
    sortBox.value = state.assetSort;
    sortBox.addEventListener("change", () => {
      state.assetSort = sortBox.value;
      renderSkins();
    });
  }
  if (orderBtn) {
    syncOrder();
    orderBtn.addEventListener("click", () => {
      state.assetOrder = state.assetOrder === "asc" ? "desc" : "asc";
      syncOrder();
      renderSkins();
    });
  }

  const sizeBox = $("#page-size");
  if (sizeBox) {
    sizeBox.value = String(state.size);
    sizeBox.addEventListener("change", () => {
      state.size = Number(sizeBox.value) || 10;
      loadPage(1);
    });
  }
  const gmBox = $("#view-mode");
  if (gmBox) {
    gmBox.addEventListener("click", (ev) => {
      const btn = ev.target.closest("button[data-gm]");
      if (!btn) return;
      state.gm = btn.dataset.gm || "all";
      syncModeChips();
      try { localStorage.setItem("valo.gm", state.gm); } catch (_) { /* 隐私模式忽略 */ }
      loadPage(1);
    });
  }

  const fixedBtn = $("#p-fixed");
  if (fixedBtn) {
    fixedBtn.addEventListener("click", async () => {
      const id = fixedBtn.dataset.id || "";
      if (!id) return;
      try {
        await navigator.clipboard.writeText(id);
        const old = fixedBtn.textContent;
        fixedBtn.textContent = "已复制固定 ID";
        setTimeout(() => { fixedBtn.textContent = old; }, 1200);
      } catch (_) {
        showError(`复制失败，固定 ID 是：${id}`);
      }
    });
  }
  // 赛季页：赛幕 chip → 拉该赛幕的官方数据并重渲染。
  const seasonPanel = $("#panel-season");
  if (seasonPanel) {
    seasonPanel.addEventListener("click", (ev) => {
      const chip = ev.target.closest(".act-chip");
      if (!chip) return;
      ev.preventDefault();
      loadCareerAct(chip.dataset.act || "");
    });
  }
  // 单局详情里点玩家名字 → 直接查他（不用回搜索框重打一遍）。
  ["#match-body", "#panel-match"].forEach((sel) => {
    const host = document.querySelector(sel);
    if (!host) return;
    host.addEventListener("click", (ev) => {
      const who = ev.target.closest(".nm-click");
      if (!who || !who.dataset.q) return;
      ev.preventDefault();
      const tab = document.querySelector('#tabs button[data-tab="history"]');
      if (tab) tab.click();
      loadPlayer(who.dataset.q, false);
    });
  });
  $("#prev").addEventListener("click", () => loadPage(state.page - 1));
  $("#next").addEventListener("click", () => loadPage(state.page + 1));
  $$(".filters .chip").forEach((chip) => chip.addEventListener("click", () => {
    $$(".filters .chip").forEach((c) => c.classList.remove("active"));
    chip.classList.add("active");
    state.filter = chip.dataset.mode;
    loadPage(1);
  }));

  // ── 导出面板 ──────────────────────────────────────────────
  const EXPORT_PARTS_KEY = "valo.exportParts";
  const EXPORT_PRIVACY_KEY = "valo.exportPrivacy";
  const privacyBox = () => $("#export-privacy");
  const privacyOn = () => !!(privacyBox() && privacyBox().checked);
  const syncPrivacy = () => {
    const box = privacyBox();
    if (!box) return;
    box.addEventListener("change", () => {
      try { localStorage.setItem(EXPORT_PRIVACY_KEY, box.checked ? "1" : "0"); } catch (_) { /* ignore */ }
    });
    try { box.checked = localStorage.getItem(EXPORT_PRIVACY_KEY) === "1"; } catch (_) { /* ignore */ }
  };
  syncPrivacy();
  const PART_KEYS = ["history", "match", "social", "party", "assets", "season"];
  const exportFmt = () => {
    const box = document.querySelector('#export-formats input[name="export-fmt"]:checked');
    return box ? box.value : "pdf";
  };
  const isDocFmt = (fmt) => fmt === "html" || fmt === "md";
  const exportBoxes = () => $$("#export-parts input[type=checkbox]");
  const checkedParts = () => exportBoxes().filter((box) => box.checked).map((box) => box.value);
  const savedParts = () => {
    try {
      const raw = localStorage.getItem(EXPORT_PARTS_KEY);
      const list = raw ? JSON.parse(raw) : null;
      return Array.isArray(list) ? list : null;
    } catch (_) {
      return null;
    }
  };
  const syncExportHint = () => {
    const hint = $("#export-hint");
    if (!hint) return;
    hint.textContent = isDocFmt(exportFmt())
      ? "文档导出会把勾选的部分排成一份分析报告（几秒就好）；一段都不勾就导出全部六段。"
      : "不勾选 = 只导出当前这一页（PDF / PNG）；勾选后按「历史 → 单局 → 好友与组队 → 最近组队 → 资产 → 赛季」的顺序合并。";
  };
  const rememberParts = () => {
    try { localStorage.setItem(EXPORT_PARTS_KEY, JSON.stringify(checkedParts())); } catch (_) { /* ignore */ }
  };
  const openExportDialog = () => {
    if (!state.keyword) {
      showError("先查一个人，再导出。");
      return;
    }
    const modal = $("#export-modal");
    if (!modal) return;
    const keep = savedParts();
    const preset = keep && keep.length ? keep : (PART_KEYS.includes(state.tab) ? [state.tab] : []);
    exportBoxes().forEach((box) => { box.checked = preset.includes(box.value); });
    syncExportHint();
    loadExportDays();
    modal.classList.remove("hidden");
    document.body.classList.add("modal-open");
    const first = modal.querySelector("input, button");
    if (first) first.focus();
  };
  const closeExportDialog = () => {
    const modal = $("#export-modal");
    if (!modal) return;
    modal.classList.add("hidden");
    document.body.classList.remove("modal-open");
  };
  if ($("#export-open")) $("#export-open").addEventListener("click", openExportDialog);
  if ($("#export-modal")) {
    $("#export-modal").addEventListener("click", (ev) => {
      if (ev.target && ev.target.dataset && ev.target.dataset.close === "1") closeExportDialog();
    });
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && !$("#export-modal").classList.contains("hidden")) closeExportDialog();
    });
    exportBoxes().forEach((box) => box.addEventListener("change", () => { syncExportHint(); rememberParts(); }));
    $$('#export-formats input[name="export-fmt"]').forEach((box) =>
      box.addEventListener("change", () => { syncExportHint(); }));
    if ($("#export-all")) $("#export-all").addEventListener("click", () => {
      exportBoxes().forEach((box) => { box.checked = true; });
      syncExportHint(); rememberParts();
    });
    if ($("#export-none")) $("#export-none").addEventListener("click", () => {
      exportBoxes().forEach((box) => { box.checked = false; });
      syncExportHint(); rememberParts();
    });
  }

  // 日期区间：不给自由输入，直接拿「真的有战绩的日子」生成两个下拉框。
  // 这样范围天然落在首场与最近一场之间，也不会因为格式写错把参数带坏。
  // 区间内的场次：选完起止立刻算给用户看，不用他再心算。
  let exportDays = [];
  let exportSpan = { total: 0, first: "", last: "" };
  const updateRangeCount = () => {
    const hint = $("#export-day-hint");
    if (!hint) return;
    if (!exportDays.length) {
      hint.textContent = "这位玩家近期没有可用的战绩日期";
      return;
    }
    const fromSel = $("#export-date-from");
    const toSel = $("#export-date-to");
    const from = (fromSel && fromSel.value) || "";
    const to = (toSel && toSel.value) || "";
    const picked = exportDays.filter((row) => (!from || row.date >= from) && (!to || row.date <= to));
    const count = picked.reduce((sum, row) => sum + row.count, 0);
    const dayCount = picked.length;
    const span = from || to
      ? `${picked.length ? picked[picked.length - 1].date : from || to} ~ ${picked.length ? picked[0].date : to || from}`
      : `${exportSpan.first} ~ ${exportSpan.last}`;
    const tail = from || to ? `已选 ${count} 场` : `共 ${exportSpan.total} 场`;
    hint.textContent = `${tail} · ${dayCount} 天有战绩 · ${span}`;
    hint.title = picked.map((row) => `${row.date}：${row.count} 场`).join("\n");
  };
  const fillDaySelects = (data) => {
    const fromSel = $("#export-date-from");
    const toSel = $("#export-date-to");
    if (!fromSel || !toSel) return;
    const keepFrom = fromSel.value;
    const keepTo = toSel.value;
    const days = (data && data.days) || [];
    exportDays = days;
    exportSpan = {
      total: Number(data && data.total) || days.reduce((sum, row) => sum + row.count, 0),
      first: (data && data.first) || (days.length ? days[days.length - 1].date : ""),
      last: (data && data.last) || (days.length ? days[0].date : ""),
    };
    const build = (sel, placeholder) => {
      const head = `<option value="">${placeholder}</option>`;
      sel.innerHTML = head + days
        .map((row) => `<option value="${row.date}">${row.date}（${row.count} 场）</option>`)
        .join("");
    };
    build(fromSel, "不限");
    build(toSel, "不限");
    if (keepFrom && days.some((row) => row.date === keepFrom)) fromSel.value = keepFrom;
    if (keepTo && days.some((row) => row.date === keepTo)) toSel.value = keepTo;
    updateRangeCount();
  };
  const loadExportDays = async () => {
    const fromSel = $("#export-date-from");
    if (!fromSel || !state.keyword) return;
    const hint = $("#export-day-hint");
    if (hint) hint.textContent = "正在统计有战绩的日期…";
    try {
      const data = await api.get("/api/history/days", { keyword: state.keyword, mode: state.source });
      fillDaySelects(data);
    } catch (err) {
      if (hint) hint.textContent = `日期统计失败：${err.message}`;
    }
  };

  const exportRangeMode = () => {
    const picked = document.querySelector('input[name="export-range"]:checked');
    return picked ? picked.value : "count";
  };
  const syncExportRange = () => {
    const dateMode = exportRangeMode() === "date";
    const countRow = $("#export-count-row");
    const dateRow = $("#export-date-row");
    if (countRow) countRow.hidden = dateMode;
    if (dateRow) dateRow.hidden = !dateMode;
    if (dateMode) updateRangeCount();
  };
  $$('input[name="export-range"]').forEach((box) => box.addEventListener("change", syncExportRange));
  syncExportRange();

  ["#export-date-from", "#export-date-to"].forEach((sel) => {
    const box = $(sel);
    if (box) box.addEventListener("change", updateRangeCount);
  });

  if ($("#share-btn")) $("#share-btn").addEventListener("click", async () => {
    if (!state.keyword) return;
    const btn = $("#share-btn");
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "生成中…";
    clearError();
    try {
      const data = await api.post("/api/share", { keyword: state.keyword, mode: state.source || "game" });
      const url = new URL(data.url, location.origin).href;
      let copied = false;
      try {
        await navigator.clipboard.writeText(url);
        copied = true;
      } catch (err) {
        const box = document.createElement("input");
        box.value = url;
        document.body.appendChild(box);
        box.select();
        copied = document.execCommand("copy");
        box.remove();
      }
      const hint = $("#export-hint");
      if (hint) {
        hint.innerHTML = `${copied ? "分享链接已复制" : "分享链接"}：<a href="${escapeHtml(data.url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a>`;
      }
    } catch (err) {
      showError(err);
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });

  if ($("#export-btn")) $("#export-btn").addEventListener("click", async () => {
    if (!state.keyword) return;
    const btn = $("#export-btn");
    const fmt = exportFmt();
    const original = btn.textContent;
    clearError();
    const parts = checkedParts().join(",");
    // 两种范围二选一：按场数就完全不传日期，按日期就让后端取区间内全部（封顶 30 场）。
    const dateMode = exportRangeMode() === "date";
    const rawCount = Number(($("#export-match-count") || {}).value);
    const matchCount = dateMode ? 0 : Math.max(1, Math.min(20, rawCount || 5));
    let dateFrom = dateMode ? ((($("#export-date-from") || {}).value) || "") : "";
    let dateTo = dateMode ? ((($("#export-date-to") || {}).value) || "") : "";
    if (dateFrom && dateTo && dateFrom > dateTo) {
      // 选反了就换过来，避免后端收到「起 > 止」直接 0 场
      const swap = dateFrom;
      dateFrom = dateTo;
      dateTo = swap;
    }
    const url = `/api/export?keyword=${encodeURIComponent(state.keyword)}&kind=${state.tab}`
      + `&mode=${state.source}&page=${state.page}&size=${state.size}&filter=${state.filter}&gm=${state.gm}`
      + `&sort=${state.assetSort}&order=${state.assetOrder}&format=${fmt}&match_count=${matchCount}`
      + (dateFrom ? `&date_from=${encodeURIComponent(dateFrom)}` : "")
      + (dateTo ? `&date_to=${encodeURIComponent(dateTo)}` : "")
      + (parts ? `&parts=${encodeURIComponent(parts)}` : "")
      + (privacyOn() ? "&privacy=1" : "")
      // 只导「单局详情」且没勾多选时，把当前正在看的那一场带上；
      // 否则后端只能按列表下标猜，换过筛选/翻页就会导成别的一场。
      // 单局详情：选 1 场就导当前这场；选多场则逐场导出（后端按 match_count 取近 N 场）。
      + (!parts && state.tab === "match" && state.matchId && matchCount <= 1
        ? `&match_id=${encodeURIComponent(state.matchId)}` : "");

    // 一律走 blob 下载：浏览器静默落到下载目录，页面不转圈、不弹新标签。
    // （开新标签看 PDF 时要等几十秒渲染，标签一直转圈，用户以为整页卡死了。）

    btn.disabled = true;
    btn.textContent = "导出中…";
    try {
      const res = await fetch(url);
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try { detail = (await res.json()).detail || detail; } catch (_) { /* ignore */ }
        throw new Error(detail);
      }
      const blob = await res.blob();
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      const ext = fmt === "md" ? "md" : fmt;
      const name = `${state.keyword}-${isDocFmt(fmt) ? "分析报告" : state.tab}.${ext}`;
      link.download = name;
      document.body.appendChild(link);
      link.click();
      setTimeout(() => { URL.revokeObjectURL(link.href); link.remove(); }, 4000);
      closeExportDialog();
      btn.textContent = `已下载 ${name}`;
      setTimeout(() => { btn.textContent = original; }, 3000);
    } catch (err) {
      showError(`导出失败：${err.message}`);
    } finally {
      btn.disabled = false;
      if (btn.textContent === "导出中…") btn.textContent = original;
    }
  });

  $("#social-filter").addEventListener("input", () => renderPeople());
  $$(".social-counts .chip").forEach((chip) => chip.addEventListener("click", () => {
    $$(".social-counts .chip").forEach((c) => c.classList.remove("active"));
    chip.classList.add("active");
    state.socialGroup = chip.dataset.group;
    renderPeople();
  }));

  const params = new URLSearchParams(location.search);
  state.pendingTab = params.get("tab");
  const presetMode = params.get("mode");
  if (presetMode === "mval" || presetMode === "game") {
    state.source = presetMode;
    $$("#search-mode button").forEach((b) => b.classList.toggle("active", b.dataset.source === presetMode));
    $("#search-input").placeholder = presetMode === "mval"
      ? "掌瓦号，如 011091448 或掌瓦昵称"
      : "游戏昵称#编号，如 眠是未觉雨#40889";
  }
  if (EXPORT_KIND) {
    document.body.classList.add("export");
    if (EXPORT_KIND === "match") document.body.classList.add("export-match");
  }
  if (EXPORT_KIND) document.body.dataset.exportPending = "1";
  const preset = params.get("q");
  if (preset) {
    $("#search-input").value = preset;
    loadPlayer(preset)
      .then(() => {
        const tab = params.get("tab");
        if (tab) switchTab(tab);
      })
      .then(() => {
        if (EXPORT_KIND) markExportReady();
      });
  } else if (EXPORT_KIND) {
    markExportReady("missing-keyword");
  }
}

// 导出截图用：**内容真的出来了**才打标记，截图端等到它才按快门。
// 以前只等图片加载完，接口慢的时候会拍到「正在拉取数据…」的空壳（导出的 PDF 一片空白）。
function exportContentCount() {
  const rows = (sel) => document.querySelectorAll(sel).length;
  if (EXPORT_KIND === "overview") return document.querySelectorAll("#player .tile, #player .id-card").length;
  if (EXPORT_KIND === "match") return rows("#match-body table.board tbody tr");
  if (EXPORT_KIND === "history") return rows("#history-rows .row");
  if (EXPORT_KIND === "party") return rows("#party-rows .row");
  const panel = document.querySelector(`#panel-${EXPORT_KIND}`) || document.querySelector(".panel:not(.hidden)");
  return panel ? panel.innerText.replace(/\s+/g, "").length : 0;
}

function markExportReady(reason = "") {
  const deadline = Date.now() + 25000;
  const tick = () => {
    // 导出图要整页拍，折叠以下的图如果还是 loading="lazy" 就永远不会开始加载，
    // 会让就绪判定一直等到超时（实测每张导出图白等 60s）。
    document.querySelectorAll('img[loading="lazy"]').forEach((el) => { el.loading = "eager"; });
    const count = exportContentCount();
    const busy = [...document.images].some((i) => i.getAttribute("src") && !i.complete);
    if ((count === 0 || busy) && Date.now() < deadline) {
      setTimeout(tick, 150);
      return;
    }
    document.body.dataset.exportCount = String(count);
    if (reason) document.body.dataset.exportNote = reason;
    document.body.dataset.exportReady = "1";
  };
  setTimeout(tick, 200);
}

boot();

const GUN_TYPES = ["近战武器", "佩枪", "冲锋枪", "霰弹枪", "步枪", "狙击枪", "机枪"];

// 枪械分组序：先按类目（近战→佩枪→冲锋枪→霰弹枪→步枪→狙击枪→机枪），同类目再按枪名。
function gunRank(item) {
  const at = GUN_TYPES.indexOf(String(item.gun_type || ""));
  return [at < 0 ? GUN_TYPES.length : at, String(item.gun || "其他")];
}

const assetPrice = (x) => {
  const n = Number(String(x.price ?? "").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : 0;
};
const assetAccess = (x) => Number(x.access) || 0;

// 卡面 / 喷漆 / 挂饰 / 英雄：一律按获取时间新→旧，拿不到时间戳就退回解锁文案倒序。
function byAccess(a, b) {
  const d = assetAccess(b) - assetAccess(a);
  return d || String(b.unlock || "").localeCompare(String(a.unlock || ""));
}

const nameCompare = (a, b) => String(a.name || "").localeCompare(String(b.name || ""), "zh");

// 排序：主键按用户选的口径与方向，**并列时一律再按获取时间（新→旧）**。
function skinSortValue(sort, order = "desc") {
  const dir = order === "asc" ? -1 : 1;
  return (a, b) => {
    let main = 0;
    if (sort === "gun") {
      const ga = gunRank(a);
      const gb = gunRank(b);
      main = ga[0] - gb[0] || ga[1].localeCompare(gb[1], "zh");
    } else if (sort === "price") {
      main = assetPrice(b) - assetPrice(a);
    } else if (sort === "unlock") {
      main = assetAccess(b) - assetAccess(a);
    } else if (sort === "level") {
      main = (Number(b.level_owned || b.level) || 0) - (Number(a.level_owned || a.level) || 0);
    } else if (sort === "quality") {
      main = (Number(b.quality) || 0) - (Number(a.quality) || 0);
    }
    if (main) return main * dir;
    return byAccess(a, b) || nameCompare(a, b);
  };
}

const SORT_LABELS = { gun: "类型分类", price: "VP 价格", unlock: "获取时间", level: "等级", quality: "品质" };
const ORDER_LABELS = { asc: "正序 ↑", desc: "逆序 ↓" };

function skinMeta(item) {
  const price = Number(item.price);
  const parts = [];
  if (item.gun) parts.push(item.gun);
  const owned = Number(item.level_owned || item.level || 0);
  const cap = Number(item.level_max || 0);
  if (owned && cap && cap > 1) parts.push(`升级 ${owned}/${cap}`);
  else if (owned) parts.push(`升级 ${owned} 级`);
  if (item.variants > 1) parts.push(`炫彩 ${item.variants}`);
  if (item.use_count) parts.push(`用过 ${item.use_count} 次`);
  if (item.quality) parts.push(`品质 ${item.quality}`);
  if (Number.isFinite(price) && price > 0) parts.push(`${price} VP`);
  const unlocked = String(item.unlock || "").slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(unlocked)) parts.push(`解锁于 ${unlocked}`);
  return parts.join(" · ");
}

function skinCard(item) {
  const swatches = (item.variant_icons || []).length > 1
    ? `<div class="swatches">${item.variant_icons.map((u) => `<img src="${img(u)}" alt="" loading="lazy" title="炫彩" />`).join("")}</div>`
    : "";
  return `
    <div class="asset">
      <img src="${img(item.icon)}" alt="" loading="lazy" />
      <span>${item.name || "—"}</span>
      <em>${skinMeta(item)}</em>
      ${swatches}
    </div>`;
}

function renderSkins() {
  const data = state.assetData || {};
  const sort = state.assetSort;
  const list = [...(data.skins || [])].sort(skinSortValue(sort, state.assetOrder)).slice(0, 120);
  const box = $("#asset-skins");
  if (!box) return;
  if (!list.length) {
    box.classList.remove("grouped");
    box.innerHTML = '<p class="dim">这个账号没有可展示的枪皮。</p>';
  } else if (sort === "gun") {
    const groups = [];
    const seen = new Map();
    list.forEach((item) => {
      const rank = gunRank(item);
      const key = rank.join("|");
      if (!seen.has(key)) {
        const group = { key, name: rank[1], type: String(item.gun_type || ""), items: [] };
        seen.set(key, group);
        groups.push(group);
      }
      seen.get(key).items.push(item);
    });
    box.classList.add("grouped");
    box.innerHTML = groups.map((g) => `
      <section class="gun-group">
        <h5>${escapeHtml(g.name)}<span>${g.items.length} 张</span>${g.type && g.type !== g.name ? `<em>${escapeHtml(g.type)}</em>` : ""}</h5>
        <div class="asset-grid">${g.items.map(skinCard).join("")}</div>
      </section>`).join("");
  } else {
    box.classList.remove("grouped");
    box.innerHTML = list.map(skinCard).join("");
  }
  const meta = $("#assets-meta");
  if (meta && data.counts) {
    const noPrice = sort === "price" && !(data.skins || []).some((x) => assetPrice(x) > 0);
    const tail = noPrice ? "（这号没有价格数据，按获取时间）" : "";
    const orderText = state.assetOrder === "asc" ? "正序" : "逆序";
    meta.textContent = `共 ${list.length} 张枪皮 · 库里 ${data.counts.guns || 0} 把枪 · 按${SORT_LABELS[sort] || "类型分类"}${orderText}${tail}`;
  }
}

function unlockLine(item) {
  const day = String(item.unlock || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? `解锁于 ${day}` : "";
}

function renderGuns(data) {
  const guns = data.guns || [];
  const box = $("#asset-guns");
  const meta = $("#guns-meta");
  if (!box) return;
  const owned = guns.reduce((n, g) => n + (Number(g.owned) || 0), 0);
  const total = guns.reduce((n, g) => n + (Number(g.total) || 0), 0);
  if (meta) meta.textContent = guns.length
    ? `共 ${guns.length} 把枪 · 已收集 ${owned} / ${total} 款${total ? `（${Math.round((owned / total) * 100)}%）` : ""}`
    : "没有拿到枪械数据";
  box.innerHTML = guns
    .map((gun) => {
      const o = Number(gun.owned) || 0;
      const t = Number(gun.total) || 0;
      const pct = t ? Math.max(o ? 4 : 0, Math.round((o / t) * 100)) : 0;
      const done = t && o >= t;
      return `<div class="gun-card${done ? " done" : ""}" title="${escapeHtml(gun.gun)} 已收集 ${o}/${t}">
        ${gun.icon ? `<img src="${img(gun.icon)}" alt="" loading="lazy">` : '<span class="gun-ph"></span>'}
        <div class="gun-body">
          <div class="gun-name">${escapeHtml(gun.gun || "未知枪械")}</div>
          <div class="gun-bar"><i style="width:${pct}%"></i></div>
          <div class="gun-num"><b>${o}</b><span> / ${t || "?"}</span>${done ? '<em>收齐</em>' : ""}</div>
        </div>
      </div>`;
    })
    .join("");
}

function renderAssetGrids(data, card) {
  renderGuns(data);
  // 不截断：卡面/喷漆/挂饰都要能看完（以前每块只给 60 件，看起来像“被吃了”）。
  const cards = [...(data.cards || [])].sort(byAccess);
  const sprays = [...(data.sprays || []), ...(data.charms || [])].sort(byAccess);
  const agents = [...(data.agents || [])].sort(byAccess);
  const owned = (list) => list.filter((item) => item.owned !== false).length;
  const meta = (box, text) => { const el = $(box); if (el) el.textContent = text; };
  meta("#cards-meta", `共 ${cards.length} 件`);
  meta("#sprays-meta", `共 ${sprays.length} 件`);
  meta("#agents-meta", `共 ${agents.length} 位`);
  $("#asset-cards").innerHTML = cards.map((item) => card(item, unlockLine(item))).join("");
  $("#asset-sprays").innerHTML = sprays.map((item) => card(item, unlockLine(item))).join("");
  $("#asset-agents").innerHTML = agents.map((item) => card(item, item.role || "英雄")).join("");
}
