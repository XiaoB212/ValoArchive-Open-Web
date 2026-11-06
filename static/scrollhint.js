/* 横向滚动提示条。
 *
 * iOS 的横向滚动条是「滚动时才闪现」的覆盖式样式，安卓部分浏览器干脆不画，
 * 结果一排 chip / 枪械按钮明明还能往右滑，用户却以为只有这几个。
 * 这里给任意带 data-hscroll 的容器在底部画一根常驻的细滚动条：
 *   - 内容没超出就整条隐藏；
 *   - 拖动滑块可以直接滚（触摸/鼠标都行）；
 *   - innerHTML 被重写、窗口缩放、容器尺寸变化都会重新测量。
 * 用法：容器加 data-hscroll 即可，脚本自己在 DOMContentLoaded 后接管。
 */
(function () {
  "use strict";

  var BAR = "hscroll-hint";
  var MIN_THUMB = 22;
  var states = [];
  var scanQueued = false;

  function position(st) {
    var el = st.el;
    var parent = el.parentElement;
    if (!parent) return false;
    if (getComputedStyle(parent).position === "static") parent.style.position = "relative";
    var r = el.getBoundingClientRect();
    var pr = parent.getBoundingClientRect();
    st.bar.style.left = Math.round(r.left - pr.left) + "px";
    st.bar.style.top = Math.round(r.bottom - pr.top - 10) + "px";
    st.bar.style.width = Math.round(r.width) + "px";
    return r.width > 0;
  }

  function paint(st) {
    var el = st.el;
    if (!el.isConnected) return;
    if (!position(st)) {
      st.bar.style.display = "none";
      return;
    }
    var sw = el.scrollWidth;
    var cw = el.clientWidth;
    var room = sw - cw;
    if (room < 6) {
      st.bar.style.display = "none";
      return;
    }
    var thumbW = Math.max(MIN_THUMB, Math.round((cw * cw) / sw));
    st.bar.style.display = "block";
    st.thumb.style.width = thumbW + "px";
    var travel = Math.max(0, cw - thumbW);
    var ratio = room ? Math.min(1, Math.max(0, el.scrollLeft / room)) : 0;
    st.thumb.style.transform = "translateX(" + Math.round(travel * ratio) + "px)";
  }

  function schedule(st) {
    if (st.raf) return;
    st.raf = requestAnimationFrame(function () {
      st.raf = 0;
      paint(st);
    });
  }

  function attach(el) {
    if (!el || el.dataset.hscrollOn === "1" || !el.parentElement) return;
    el.dataset.hscrollOn = "1";
    var bar = document.createElement("div");
    bar.className = BAR;
    bar.setAttribute("aria-hidden", "true");
    var thumb = document.createElement("i");
    bar.appendChild(thumb);
    el.parentElement.appendChild(bar);
    var st = { el: el, bar: bar, thumb: thumb, raf: 0 };
    states.push(st);

    el.addEventListener("scroll", function () { schedule(st); }, { passive: true });
    bar.addEventListener("pointerdown", function (event) {
      if (event.button) return;
      var box = bar.getBoundingClientRect();
      var tw = thumb.offsetWidth;
      var span = Math.max(1, box.width - tw);
      var room = Math.max(0, el.scrollWidth - el.clientWidth);
      function move(clientX) {
        var x = Math.min(span, Math.max(0, clientX - box.left - tw / 2));
        el.scrollLeft = (x / span) * room;
      }
      move(event.clientX);
      function onMove(ev) { move(ev.clientX); ev.preventDefault(); }
      function onUp() {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
      }
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
      event.preventDefault();
    });

    if (window.ResizeObserver) {
      st.ro = new ResizeObserver(function () { schedule(st); });
      st.ro.observe(el);
    }
    schedule(st);
  }

  function scan(root) {
    var scope = root && root.querySelectorAll ? root : document;
    var list = scope.querySelectorAll("[data-hscroll]");
    for (var i = 0; i < list.length; i += 1) attach(list[i]);
  }

  function refresh() {
    for (var i = 0; i < states.length; i += 1) schedule(states[i]);
  }

  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(function () {
      scanQueued = false;
      scan();
      refresh();
    });
  }

  window.scrollHint = { scan: scan, refresh: refresh };

  function boot() {
    scan();
    if (window.MutationObserver) {
      new MutationObserver(queueScan).observe(document.body, { childList: true, subtree: true });
    }
    window.addEventListener("resize", refresh);
    window.addEventListener("orientationchange", refresh);
    // 字体晚到会让宽度变一次，进来后再量一遍。
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(refresh);
    setTimeout(refresh, 600);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
