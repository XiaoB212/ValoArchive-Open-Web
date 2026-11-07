/* ValoArchive-Open-Web —— 部署时改这里即可，页面本身不用动。
 *
 * apiBase：后端地址（同一个 ValoArchive-Web 后端）。留空表示与页面同源，比如把
 *          静态站和后端放同一台机器的 80 端口反代。
 * apiKey ：写死的后端口令。留空 = 「访客自己输口令」模式：页面弹出登录框，
 *          口令由站长在个人站点签发（scripts/key.py），到期自动失效、可吊销。
 *          口令只存在访客浏览器里，不进静态文件。
 */
window.VALO_CONFIG = {
  apiBase: "",
  apiKey: ""
};

(function () {
  "use strict";

  var cfg = (window.VALO_CONFIG = window.VALO_CONFIG || {});
  var BASE = String(cfg.apiBase || "").replace(/\/+$/, "");
  var STORE_KEY = "va.gate.v1";

  // ---------------------------------------------------------------- 小工具

  function lsGet(k) {
    try { return localStorage.getItem(k); } catch (e) { return null; }
  }
  function lsSet(k, v) {
    try { localStorage.setItem(k, v); } catch (e) { /* 隐私模式忽略 */ }
  }
  function lsDel(k) {
    try { localStorage.removeItem(k); } catch (e) { /* 忽略 */ }
  }

  // ---------------------------------------------------------------- 门禁状态

  var GATE = (window.VALO_GATE = {
    key: "",
    ok: false,
    locked: false,
    label: "",
    expires: 0,
    source: "",
    needLogin: false
  });

  var readyResolve = null;
  var ready = new Promise(function (res) { readyResolve = res; });
  function openDoor() {
    GATE.ok = true;
    GATE.locked = false;
    readyResolve();
  }

  function readStoredKey() {
    var raw = lsGet(STORE_KEY);
    if (!raw) return "";
    try {
      var row = JSON.parse(raw);
      if (!row || typeof row.k !== "string") return "";
      if (row.exp && row.exp * 1000 < Date.now()) { lsDel(STORE_KEY); return ""; }
      return row.k;
    } catch (e) {
      return "";
    }
  }
  function saveKey(key, expires) {
    GATE.key = key;
    lsSet(STORE_KEY, JSON.stringify({ k: key, exp: Number(expires) || 0 }));
  }

  var nativeFetch = window.fetch ? window.fetch.bind(window) : null;

  // 握手：口令对不对，以这个接口说的为准（恒 200，只看 ok）。
  function verify(key) {
    var init = { cache: "no-store" };
    if (key) init.headers = { "X-Access-Key": key };
    return nativeFetch(BASE + "/api/gate/verify", init)
      .then(function (res) { return res.json(); })
      .catch(function () {
        // 后端暂时连不上：不要把人锁在门外，用本地缓存先看（source=offline）。
        return { ok: true, source: "offline" };
      });
  }

  // ---------------------------------------------------------------- 本地缓存
  // 只缓存 GET /api/* 的 JSON（单局详情 200KB+，图片交给浏览器 HTTP 缓存）。

  var CACHE_DB = "valoarchive-cache";
  var CACHE_STORE = "http";
  var CACHE_MAX = 400;
  var mem = new Map();
  var dbp = null;

  function dbOpen() {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve) {
      if (!window.indexedDB) return resolve(null);
      function attempt(version) {
        var req;
        try {
          req = version ? indexedDB.open(CACHE_DB, version) : indexedDB.open(CACHE_DB);
        } catch (e) {
          return resolve(null);
        }
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains(CACHE_STORE)) db.createObjectStore(CACHE_STORE);
        };
        req.onerror = function () { resolve(null); };
        req.onblocked = function () { resolve(null); };
        req.onsuccess = function () {
          var db = req.result;
          if (db.objectStoreNames.contains(CACHE_STORE)) return resolve(db);
          // 库里没有表（旧版本或别的东西建过同名库）：升一级把表补上
          var next = db.version + 1;
          db.close();
          attempt(next);
        };
      }
      attempt(0);
    });
    return dbp;
  }
  function req2p(request) {
    return new Promise(function (res, rej) {
      request.onsuccess = function () { res(request.result); };
      request.onerror = function () { rej(request.error); };
    });
  }
  function withStore(mode, fn) {
    return dbOpen().then(function (db) {
      if (!db || !db.objectStoreNames.contains(CACHE_STORE)) return null;
      try {
        return fn(db.transaction(CACHE_STORE, mode).objectStore(CACHE_STORE));
      } catch (e) {
        return null;
      }
    }).catch(function () { return null; });
  }

  function cacheGet(url) {
    return withStore("readonly", function (st) { return req2p(st.get(url)); })
      .then(function (row) {
        if (row && typeof row.b === "string") return row;
        var m = mem.get(url);
        return m ? { t: m.t, b: m.b } : null;
      });
  }

  function cachePut(url, body) {
    if (!body || body.length > 3e6) return; // 3MB 以上不落盘
    mem.set(url, { t: Date.now(), b: body });
    if (mem.size > 120) mem.delete(mem.keys().next().value);
    withStore("readwrite", function (st) {
      st.put({ t: Date.now(), b: body }, url);
      return req2p(st.count()).then(function (n) {
        if (n > CACHE_MAX) prune(st);
        return null;
      });
    });
  }

  function prune(st) {
    return Promise.all([req2p(st.getAll()), req2p(st.getAllKeys())])
      .then(function (pair) {
        var rows = pair[0] || [];
        var keys = pair[1] || [];
        var order = rows.map(function (r, i) { return { k: keys[i], t: (r && r.t) || 0 }; });
        order.sort(function (a, b) { return a.t - b.t; });
        order.slice(0, Math.max(20, order.length - CACHE_MAX)).forEach(function (r) {
          st.delete(r.k);
        });
        return null;
      })
      .catch(function () { return null; });
  }

  // 缓存活了多久：比赛详情是历史数据，可以放很久；玩家资料会变，短一点。
  function ttlFor(url) {
    var p = String(url).replace(/^https?:\/\/[^/]+/, "");
    if (/^\/api\/(health|gate|auth)/.test(p)) return 0;
    // 导出与卡片返回的是二进制（PNG/PDF/ZIP），缓存层只会把 blob 当文本存坏，
    // 第二次请求就拿到一个 content-type 是 json 的假文件。一律不缓存。
    if (/^\/api\/(export|card)/.test(p)) return 0;
    if (/^\/api\/match(\?|$)/.test(p)) return 30 * 864e5;
    if (/^\/api\/player\/(assets|career|season|rank)/.test(p)) return 864e5;
    if (/^\/api\/(catalog|maps|gear|bundles|agents|skins|lineups|crosshair)/.test(p)) return 864e5;
    if (/^\/api\/player/.test(p)) return 600e3;
    if (/^\/api\/search/.test(p)) return 120e3;
    if (/^\/api\//.test(p)) return 300e3;
    return 0;
  }

  function cachedResponse(body, kind) {
    return new Response(body, {
      status: 200,
      statusText: "OK",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "X-Local-Cache": kind
      }
    });
  }

  // ---------------------------------------------------------------- 地址改写

  // 页面里 <img src>、CSS 背景图不走 fetch，由这个函数拼绝对地址。
  // 后端把资料库图片统一给成 /img?url=…，静态站自己没这个路由。
  window.valoAsset = function (url) {
    var s = url == null ? "" : String(url);
    if (!s || s.charAt(0) !== "/" || s.indexOf("/static/") === 0) return s;
    if (!BASE) return s;
    var out = BASE + s;
    var key = cfg.apiKey || GATE.key;
    if (key) out += (out.indexOf("?") === -1 ? "?" : "&") + "key=" + encodeURIComponent(key);
    return out;
  };

  function resolveUrl(input) {
    var raw;
    if (typeof input === "string") raw = input;
    else if (input && typeof input.url === "string") raw = input.url;
    else raw = String(input);
    if (raw.charAt(0) === "/") {
      if (raw.indexOf("/static/") === 0) return raw;
      return BASE + raw;
    }
    if (BASE) {
      var u;
      try { u = new URL(raw, location.href); } catch (e) { return raw; }
      // app.js 习惯先 new URL(path, location.origin) 再 fetch，这里把同源的
      // /api/*、/img* 改指到 apiBase —— 否则配了 apiBase 也照样打到静态站上。
      if (u.origin === location.origin &&
          (u.pathname.indexOf("/api/") === 0 || u.pathname.indexOf("/img") === 0)) {
        return BASE + u.pathname + u.search;
      }
    }
    return raw;
  }

  // ---------------------------------------------------------------- fetch 接管

  if (nativeFetch) {
    window.fetch = function (input, init) {
      return ready.then(function () {
        var url = resolveUrl(input);
        var opts = {};
        if (init) for (var k in init) if (Object.prototype.hasOwnProperty.call(init, k)) opts[k] = init[k];
        if (input && typeof input === "object" && typeof input.method === "string" && !opts.method) {
          opts.method = input.method;
        }
        var method = String(opts.method || "GET").toUpperCase();

        var headers;
        try {
          headers = new Headers(opts.headers || (input && input.headers) || undefined);
        } catch (e) {
          headers = new Headers();
        }
        var key = cfg.apiKey || GATE.key;
        if (key) headers.set("X-Access-Key", key);
        opts.headers = headers;

        var ttl = method === "GET" ? ttlFor(url) : 0;
        if (!ttl || /[?&]nocache=1/.test(url)) return nativeFetch(url, opts);

        return cacheGet(url).then(function (hit) {
          if (hit && Date.now() - hit.t < ttl) return cachedResponse(hit.b, "HIT");
          return nativeFetch(url, opts).then(function (res) {
            // 只缓存 JSON。图片、导出包这类二进制一旦被当文本存进去就是坏数据。
            var ctype = "";
            try {
              ctype = String((res.headers && res.headers.get("content-type")) || "");
            } catch (e) { ctype = ""; }
            if (res && res.ok && ctype.indexOf("json") !== -1) {
              try {
                res.clone().text().then(function (txt) { cachePut(url, txt); });
              } catch (e) { /* clone 失败就算了 */ }
            }
            return res;
          }).catch(function (err) {
            // 断网时把旧数据先顶上，总比一片空白好。
            if (hit) return cachedResponse(hit.b, "STALE");
            throw err;
          });
        });
      });
    };
  }

  window.valoCacheClear = function () {
    mem.clear();
    return withStore("readwrite", function (st) { return req2p(st.clear()); })
      .then(function () { return true; });
  };

  // ---------------------------------------------------------------- 登录框

  function el(tag, css, text) {
    var n = document.createElement(tag);
    if (css) n.style.cssText = css;
    if (text != null) n.textContent = text;
    return n;
  }

  function showGate() {
    GATE.locked = true;
    if (document.getElementById("va-gate")) return;

    var box = el("div", [
      "position:fixed", "inset:0", "z-index:2147483000",
      "display:flex", "align-items:center", "justify-content:center",
      "padding:24px", "background:#f7f6f2",
      "background-image:radial-gradient(rgba(14,124,107,.08) 1px, transparent 1px)",
      "background-size:22px 22px",
      "font-family:\"MiSans\",\"PingFang SC\",\"Microsoft YaHei UI\",system-ui,sans-serif"
    ].join(";"));
    box.id = "va-gate";

    var card = el("div", [
      "width:100%", "max-width:390px", "background:#fff",
      "border:1px solid #e6e3da", "border-radius:14px",
      "padding:30px 28px 24px",
      "box-shadow:0 18px 50px rgba(23,25,27,.10), 0 2px 0 rgba(23,25,27,.02)"
    ].join(";"));

    var mark = el("div", [
      "font:600 11px/1 \"Cascadia Mono\",\"JetBrains Mono\",Consolas,monospace",
      "letter-spacing:.22em", "color:#0e7c6b", "text-transform:uppercase",
      "margin-bottom:16px"
    ].join(";"), "VALOARCHIVE · 门禁");

    var title = el("div", [
      "font-size:23px", "font-weight:700", "letter-spacing:-.2px",
      "color:#17191b", "margin-bottom:8px"
    ].join(";"), "请输入访问口令");

    var sub = el("div", [
      "font-size:13px", "line-height:1.65", "color:#6f787c", "margin-bottom:20px"
    ].join(";"), "这是非公开的档案站。口令由站长签发，到期自动失效；输一次这台设备就记住了。");

    var input = el("input", [
      "width:100%", "box-sizing:border-box", "padding:12px 13px",
      "font:14px/1.2 \"Cascadia Mono\",Consolas,ui-monospace,monospace",
      "letter-spacing:.04em", "color:#17191b", "background:#fbfaf7",
      "border:1px solid #d3cfc2", "border-radius:9px", "outline:none"
    ].join(";"));
    input.type = "password";
    input.placeholder = "粘贴口令";
    input.autocomplete = "off";
    input.spellcheck = false;

    var btn = el("button", [
      "width:100%", "margin-top:12px", "padding:12px 14px",
      "font-size:14px", "font-weight:600", "color:#fff",
      "background:#0e7c6b", "border:0", "border-radius:9px",
      "cursor:pointer", "letter-spacing:.02em"
    ].join(";"), "进入档案");

    var msg = el("div", [
      "min-height:18px", "margin-top:12px", "font-size:12.5px",
      "line-height:1.5", "color:#c0453c"
    ].join(";"));

    var foot = el("div", [
      "margin-top:18px", "padding-top:14px", "border-top:1px solid #efece4",
      "font-size:11.5px", "line-height:1.6", "color:#9aa1a4"
    ].join(";"), "非官方《无畏契约》社区项目 · 数据仅供参考");

    card.appendChild(mark);
    card.appendChild(title);
    card.appendChild(sub);
    card.appendChild(input);
    card.appendChild(btn);
    card.appendChild(msg);
    card.appendChild(foot);
    box.appendChild(card);
    if (document.body) {
      document.body.appendChild(box);
    } else {
      // config.js 在 <head> 里执行，极早期（离线、握手秒失败）还没有 body。
      document.addEventListener("DOMContentLoaded", function () {
        document.body.appendChild(box);
      }, { once: true });
    }

    var busy = false;
    function submit() {
      var val = input.value.trim();
      if (busy) return;
      if (!val) { msg.textContent = "口令不能为空"; input.focus(); return; }
      busy = true;
      btn.disabled = true;
      btn.style.opacity = "0.65";
      msg.style.color = "#6f787c";
      msg.textContent = "正在校验…";
      verify(val).then(function (r) {
        if (r && r.ok) {
          saveKey(val, r.expires);
          GATE.label = r.label || "";
          GATE.expires = r.expires || 0;
          msg.style.color = "#16866a";
          msg.textContent = "验证通过，正在载入…";
          location.reload();
          return;
        }
        busy = false;
        btn.disabled = false;
        btn.style.opacity = "1";
        msg.style.color = "#c0453c";
        msg.textContent = r && r.reason === "bad_key" ? "口令不对，或已经过期了" : "口令不对，或已经过期了";
        input.select();
      }).catch(function () {
        busy = false;
        btn.disabled = false;
        btn.style.opacity = "1";
        msg.style.color = "#c0453c";
        msg.textContent = "连不上后端，稍后再试";
      });
    }

    btn.addEventListener("click", submit);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") submit();
    });
    setTimeout(function () { input.focus(); }, 30);
  }

  // ---------------------------------------------------------------- 启动

  if (!nativeFetch) {
    openDoor();
    return;
  }

  (function boot() {
    var urlKey = "";
    try {
      var q = new URLSearchParams(location.search);
      urlKey = (q.get("key") || "").trim();
      if (urlKey) {
        q.delete("key");
        var clean = location.pathname + (q.toString() ? "?" + q.toString() : "") + location.hash;
        history.replaceState(null, "", clean); // 口令别留在地址栏里
      }
    } catch (e) { /* 老浏览器 */ }

    var stored = readStoredKey();
    var candidate = urlKey || stored || String(cfg.apiKey || "").trim();

    if (!candidate) {
      return verify("").then(function (r) {
        if (r && r.ok) {
          GATE.label = r.label || "";
          GATE.source = r.source || "";
          openDoor();
        } else if (r && (r.gate === false || r.code === "need_login")) {
          // 口令层已经关掉（公开站）：不发口令，直接让人看页面。
          // 真正要数据的接口会回 401，那时前端弹登录卡，login.js 负责引导去 /account。
          GATE.needLogin = true;
          openDoor();
        } else {
          showGate();
        }
      });
    }

    verify(candidate).then(function (r) {
      if (r && r.ok) {
        GATE.key = candidate;
        GATE.label = r.label || "";
        GATE.expires = r.expires || 0;
        GATE.source = r.source || "";
        // 从链接带进来的口令，验证通过就记下来，下次不用再带
        if (urlKey) saveKey(candidate, r.expires);
        openDoor();
      } else if (r && (r.gate === false || r.code === "need_login" || r.reason === "need_key")) {
        // 存过的旧口令在新策略下没用：清掉，按「不需要口令」处理。
        lsDel(STORE_KEY);
        GATE.needLogin = true;
        openDoor();
      } else {
        lsDel(STORE_KEY);
        showGate();
      }
    });
  })();
})();