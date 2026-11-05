/* 顶栏那颗「服务正常」小绿灯。
 *
 * 用户的原话是「状态绿灯应该是摆在明面上的」——所以不再藏在 /status 页里，
 * 每个页面顶部都挂一颗，点一下就去状态页看详情。
 *
 * 判定口径与 /api/status 一致：
 *   ok    后端活着、上游登录态也都正常     → 绿灯「服务正常」
 *   warn  后端活着，但上游服务到期/掉线     → 黄灯「上游异常」
 *   bad   请求都发不出去（后端挂了/断网）   → 红灯「服务离线」
 * 每 60 秒刷新一次，切回标签页时立刻补刷。
 */
(function () {
  var box = null;
  var timer = null;
  var STATE = {
    ok: { cls: "is-ok", text: "服务正常", tip: "站点运行正常，可以正常查询" },
    warn: { cls: "is-warn", text: "上游异常", tip: "上游服务到期，暂时查不到新数据" },
    bad: { cls: "is-bad", text: "服务离线", tip: "连不上服务器，请稍后再试" },
    wait: { cls: "is-wait", text: "检测中", tip: "正在检测站点状态" }
  };

  function mount() {
    if (box) return box;
    var nav = document.querySelector(".tool-nav");
    var host = nav || document.querySelector("header.top .top-inner");
    if (!host) return null;
    box = document.createElement("a");
    box.id = "svc-dot";
    box.className = "svc-dot " + STATE.wait.cls;
    box.href = "/status";
    box.title = STATE.wait.tip;
    box.innerHTML = '<i aria-hidden="true"></i><span>检测中</span>';
    if (nav) {
      // 工具页的导航条：贴到右边，不打断链接顺序
      box.style.marginLeft = "auto";
      nav.appendChild(box);
    } else {
      // 首页顶栏：放在「导出」按钮左边
      var anchor = document.getElementById("export-open");
      if (anchor && anchor.parentNode === host) host.insertBefore(box, anchor);
      else host.appendChild(box);
    }
    return box;
  }

  function paint(state) {
    var el = mount();
    if (!el) return;
    var s = STATE[state] || STATE.wait;
    el.className = "svc-dot " + s.cls;
    el.title = s.tip;
    var label = el.querySelector("span");
    if (label) label.textContent = s.text;
  }

  function probe() {
    fetch("/api/status", { cache: "no-store", credentials: "same-origin" })
      .then(function (res) {
        if (!res.ok) throw new Error(String(res.status));
        return res.json();
      })
      .then(function (data) {
        var up = data && data.upstream;
        if (data && data.ok && (up === undefined || up === "ok")) paint("ok");
        else paint("warn");
      })
      .catch(function () {
        paint("bad");
      });
  }

  function boot() {
    mount();
    probe();
    if (timer) clearInterval(timer);
    timer = setInterval(probe, 60000);
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) probe();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();