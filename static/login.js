/* 登录态区块（也嵌在 /valoadmin 里）：整体包一层 IIFE，避免和管理页脚本
   里的 $ / state 这些名字打架。 */
(function () {
  const api = {
    async get(path, params = {}) {
      const url = new URL(path, location.origin);
      Object.entries(params).forEach(([k, v]) => v != null && url.searchParams.set(k, v));
      const res = await fetch(url);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.detail || `请求失败（${res.status}）`);
      return body;
    },
    async post(path, params = {}) {
      const url = new URL(path, location.origin);
      Object.entries(params).forEach(([k, v]) => v != null && url.searchParams.set(k, v));
      const res = await fetch(url, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.detail || `请求失败（${res.status}）`);
      return body;
    },
  };

  const LABELS = { mval: "主会话", aclos: "长历史令牌", wegame: "名字服务", pd: "辅助令牌" };
  const state = { kinds: {}, timer: null, sid: null };

  function renderStatus(data) {
    const eff = data.effective || {};
    const rows = ["mval", "aclos", "wegame", "pd"].map((key) => {
      const ok = !!eff[key];
      return `<div class="status ${ok ? "ok" : "off"}">
        <div class="dot"></div>
        <div class="status-main"><b>${LABELS[key]}</b></div>
        <code>${ok ? "已登录" : "未登录"}</code>
        ${ok && key !== "pd" ? `<button class="plain tiny" data-clear="${key}">清除</button>` : ""}
      </div>`;
    });
    const host = document.getElementById("status");
    if (host) host.innerHTML = rows.join("");
    document.querySelectorAll("[data-clear]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("清除这份凭证？清除后需要重新扫码。")) return;
        await api.post("/api/auth/clear", { section: btn.dataset.clear });
        load();
      });
    });
  }

  function renderKinds(kinds) {
    document.getElementById("kinds").innerHTML = Object.entries(kinds)
      .map(([kind, label]) => `<button class="kind" data-kind="${kind}">${label}</button>`)
      .join("");
    document.querySelectorAll(".kind").forEach((btn) => {
      btn.addEventListener("click", () => start(btn.dataset.kind, btn.textContent));
    });
  }

  function markKind(kind) {
    document.querySelectorAll(".kind").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.kind === kind);
    });
  }

  async function start(kind, label) {
    clearInterval(state.timer);
    state.sid = null;
    const scan = document.getElementById("scan");
    const qr = document.getElementById("qr");
    const stateEl = document.getElementById("scan-state");
    scan.hidden = false;
    qr.removeAttribute("src");
    delete qr.dataset.for;
    scan.classList.add("loading");
    scan.dataset.label = label;
    stateEl.textContent = `${label}：正在生成二维码…`;
    stateEl.className = "scan-state";
    markKind(kind);
    let sid = null;
    try {
      const data = await api.post("/api/login/start", { kind });
      sid = data.id;
      state.sid = sid;
    } catch (err) {
      scan.classList.remove("loading");
      stateEl.textContent = err.message;
      stateEl.className = "scan-state bad";
      markKind("");
      return;
    }

    state.timer = setInterval(async () => {
      // 旧会话的轮询可能还在路上：这时只退出自己，别去动 state.timer——
      // 那已经是新会话的定时器了，清掉它新二维码就永远画不出来。
      if (sid !== state.sid) return;
      try {
        const st = await api.get("/api/login/status", { id: sid });
        if (st.status === "waiting" && qr.dataset.for !== sid) {
          // 二维码是后台取回来的：再单独拉一次图，别把 base64 塞进轮询响应里。
          // 每个会话都换一个 URL（带 t=），否则浏览器可能沿用上一张缓存图。
          qr.dataset.for = sid;
          qr.src = `/api/login/qr?id=${encodeURIComponent(sid)}&t=${Date.now()}`;
          scan.classList.remove("loading");
        }
        stateEl.textContent = `${label}：${st.message}`;
        if (st.status === "ok") {
          stateEl.className = "scan-state ok";
          clearInterval(state.timer);
          state.sid = null;
          scan.classList.remove("loading");
          markKind("");
          load();
        } else if (st.status === "error" || st.status === "cancelled") {
          stateEl.className = "scan-state bad";
          clearInterval(state.timer);
          state.sid = null;
          scan.classList.remove("loading");
          markKind("");
        }
      } catch (err) {
        stateEl.textContent = err.message;
        stateEl.className = "scan-state bad";
        clearInterval(state.timer);
        state.sid = null;
        scan.classList.remove("loading");
        markKind("");
      }
    }, 1200);
  }

  async function load() {
    try {
      const health = await api.get("/api/health");
      const on = Object.entries(health.credentials || {}).filter(([, v]) => v).length;
      const chip = document.getElementById("health");
      if (chip) chip.textContent = `凭证 ${on} / 4`;
      const status = await api.get("/api/auth/status");
      renderStatus(status);
      if (!document.querySelector(".kind")) renderKinds(status.sources || {});
    } catch (err) {
      const chip = document.getElementById("health");
      if (chip) chip.textContent = err.message;
    }
  }

  const refreshBtn = document.getElementById("refresh");
  if (refreshBtn) refreshBtn.addEventListener("click", load);
  const againBtn = document.getElementById("again");
  if (againBtn)
    againBtn.addEventListener("click", () => {
      clearInterval(state.timer);
      document.getElementById("scan").hidden = true;
    });
  load();
})();
