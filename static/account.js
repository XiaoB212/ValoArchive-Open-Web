/* 我的账号：登录 / 注册 / 会员状态 / 卡密核销 / 改密码。
   协议见 server/sub/auth_api.py；这里只做展示和错误翻译。 */
(function () {
  "use strict";

  function q(id) { return document.getElementById(id); }

  function fmt(ts) {
    if (!ts) return "—";
    var d = new Date(Number(ts) * 1000);
    if (isNaN(d.getTime())) return "—";
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0") + " " + String(d.getHours()).padStart(2, "0") + ":" +
      String(d.getMinutes()).padStart(2, "0");
  }

  function say(box, text, kind) {
    box.textContent = text;
    box.className = "ac-out" + (kind ? " " + kind : "");
  }

  // 邀请链接 /account?invite=CODE 进来时自动填好。
  (function prefillInvite() {
    try {
      var code = new URLSearchParams(location.search).get("invite") || "";
      if (code && q("r-invite")) {
        q("r-invite").value = code.trim().toUpperCase();
        if (q("tab-register")) q("tab-register").click();
      }
    } catch (e) { /* 老浏览器没有 URLSearchParams 就算了 */ }
  })();

  var MSG = {
    bad_qq: "QQ 号填 5~12 位数字。",
    weak_password: "密码至少 8 位。",
    exists: "这个 QQ 已经注册过，直接登录就行。",
    not_found: "没有这个账号，先注册。",
    bad_password: "QQ 号或密码不对。",
    disabled: "这个账号被停用了，找站长。",
    need_login: "先登录再操作。",
    rate: "操作太频繁，等一分钟再试。",
    not_found_code: "这个授权码不存在，检查一下字符。",
    revoked: "这个授权码已被作废。",
    used: "这个码已经被用过了。",
    expired_code: "这个码过期了，找站长要新的。",
    register_full: "注册名额已经满了，只能凭邀请码注册。",
    register_closed: "暂时关闭注册，过阵子再来。",
    agree_required: "请先勾选并同意《用户协议与免责声明》。",
    invite_required: "现在只能凭邀请码注册，找会员要一个。",
    invite_not_found: "邀请码不存在，检查一下字符。",
    invite_used: "这个邀请码已经被人用过了。",
    invite_revoked: "这个邀请码已被作废。"
  };

  function reasonOf(data) {
    var d = data && data.detail;
    if (d && typeof d === "object") return d.reason || "";
    if (typeof d === "string") return d;
    return "";
  }

  async function post(path, body) {
    var resp = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body || {})
    });
    var data = await resp.json().catch(function () { return {}; });
    return { ok: resp.ok, status: resp.status, data: data };
  }

  var me = null;

  function show(id, on) {
    q(id).classList.toggle("ac-hide", !on);
  }

  function render(data) {
    me = data || {};
    var logged = !!me.logged_in;
    var m = me.member || {};

    show("view-out", !logged);
    show("view-in", logged);
    show("view-redeem", logged);
    show("view-password", logged);

    if (!logged) {
      if (me.has_member_cookie && me.qq) {
        q("l-qq").value = me.qq;
        q("r-qq").value = me.qq;
        q("member-cookie-tip").hidden = false;
      }
      return;
    }

    var heroT = q("hero-title"), heroS = q("hero-sub");
    if (heroT) heroT.textContent = "你好，" + ((me.nick || me.qq || "").toString().trim() || "指挥官");
    if (heroS) heroS.textContent = m.active
      ? "会员有效中，到期 " + fmt(m.expires_at) + "；全部历史、单局详情与导出都解锁了。"
      : "已登录：免费额度每天重置，会员开通后能看全部历史、单局详情与导出。";
    q("i-qq").textContent = me.qq || "—";
    q("i-nick").textContent = me.nick || "—";
    var dispName = (me.nick || me.qq || "我的账号").toString().trim();
    q("i-name").textContent = dispName;
    q("i-av").textContent = dispName.slice(0, 1).toUpperCase();
    q("i-sub").textContent = m.active
      ? (m.scope ? "特约订阅 · 只看 " + m.scope : "会员") + " · 剩余 " + m.days_left + " 天"
      : (m.known ? "会员已过期，续期后立刻恢复" : "普通用户 · 免费额度每天重置");
    q("d-qq").value = me.qq || "";
    q("i-enter").onclick = null;

    if (m.active) {
      q("i-status").innerHTML = '<span class="ac-badge on">有效</span>';
      q("i-expires").textContent = fmt(m.expires_at) + "（还剩 " + m.days_left + " 天）";
      q("i-tip").textContent = m.scope
        ? "这是「只看 " + m.scope + "」的特约订阅：查别人会被挡下，需要升级成普通会员。"
        : "到期后查询会暂停，续期立刻恢复。";
      q("i-enter").textContent = "进入站点";
      q("i-enter").href = "/";
      loadInvites(true);
    } else if (m.known) {
      q("i-status").innerHTML = '<span class="ac-badge off">已过期</span>';
      q("i-expires").textContent = fmt(m.expires_at) + "（已过期）";
      q("i-tip").textContent = "拿一个新的授权码在下面核销，或者加群订阅。";
      q("i-enter").textContent = "去续费";
      q("i-enter").href = "/redeem";
    } else {
      q("i-status").innerHTML = '<span class="ac-badge off">未开通</span>';
      q("i-expires").textContent = "—";
      q("i-tip").textContent = "这个账号还没有会员记录：用授权码激活，或者加群订阅。";
      q("i-enter").textContent = "用授权码激活";
      q("i-enter").href = "#";
      q("i-enter").onclick = function (ev) { ev.preventDefault(); q("d-code").focus(); };
      loadInvites(false);
    }

    // 浏览器里还带着另一个 QQ 的卡密会员时：后台按账号 QQ 查是「普通」，用户却在别处
    // 看到会员，两边对不上。这里直接提示并提供「并入当前账号」。
    var other = me.other_member || null;
    var banner = q("merge-banner");
    if (banner) {
      if (other && !localStorage.getItem("va-merge-skip")) {
        banner.hidden = false;
        q("merge-text").textContent =
          "这个浏览器上还有一份会员，属于 QQ " + other.qq + "（剩 " + other.days_left +
          " 天）；当前账号是 " + (me.qq || "—") + "。并过来以后，后台和账号页显示的会员就是同一个身份了。";
      } else {
        banner.hidden = true;
      }
    }
  }

  async function adoptMember() {
    var btn = q("merge-do");
    if (btn) { btn.disabled = true; btn.textContent = "正在合并…"; }
    try {
      var resp = await fetch("/api/auth/adopt-member", { method: "POST", credentials: "same-origin" });
      var data = await resp.json().catch(function () { return {}; });
      if (!resp.ok) throw new Error((data.detail && data.detail.message) || "合并失败");
      if (typeof toast === "function") toast("会员已并入当前账号");
      localStorage.removeItem("va-merge-skip");
      await load();
    } catch (err) {
      if (typeof toast === "function") toast("合并失败：" + err.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "并入当前账号"; }
    }
  }

  async function loadInvites(active) {
    var box = q("inv-box");
    if (!box) return;
    if (!active) { box.hidden = true; return; }
    box.hidden = false;
    try {
      var resp = await fetch("/api/auth/invites", { credentials: "same-origin" });
      var data = await resp.json().catch(function () { return {}; });
      if (!resp.ok) { q("inv-code").textContent = "读取失败"; return; }
      var list = data.invites || [];
      var open = null;
      for (var i = 0; i < list.length; i++) {
        if (!list[i].used_by && !list[i].revoked) { open = list[i]; break; }
      }
      if (!open) {
        q("inv-code").textContent = "已用完，找站长再要";
        q("inv-note").textContent = "邀请码由站长发放。";
        q("inv-copy").disabled = true;
        return;
      }
      q("inv-code").textContent = open.code;
      q("inv-note").textContent = "邀请链接：" + location.origin + "/account?invite=" + open.code;
      q("inv-copy").disabled = false;
      q("inv-copy").onclick = async function () {
        var link = location.origin + "/account?invite=" + open.code;
        try {
          await navigator.clipboard.writeText(link);
          q("inv-note").textContent = "已复制：" + link;
        } catch (e) {
          q("inv-note").textContent = "复制失败，手动抄：" + link;
        }
      };
    } catch (e) {
      q("inv-code").textContent = "读取失败";
    }
  }

  function showInviteRow(on) {
    var row = q("r-invite-row");
    if (!row) return;
    if (on) row.removeAttribute("hidden");
    else row.setAttribute("hidden", "");
  }

  async function loadLimits() {
    try {
      var resp = await fetch("/api/auth/limits", { credentials: "same-origin" });
      if (!resp.ok) return;
      var data = await resp.json();
      ["query", "history", "detail"].forEach(function (k) {
        var el = q("lim-" + k);
        var val = data[k + (k === "query" ? "_per_day" : k === "detail" ? "_per_day" : "")];
        if (el && val != null) el.textContent = String(val);
      });
      // 免费注册是默认：只有后台把「必须邀请码」打开时，才露出那个输入框。
      if (data.invite_only) showInviteRow(true);
      var note = q("lim-note");
      if (note) {
        if (!data.register_open) note.textContent = "当前暂停注册；已有账号照常登录。免费额度按自然日重置。";
        else if (data.max_accounts) note.textContent = "全站限额 " + data.max_accounts + " 人注册；免费额度按自然日重置。";
      }
    } catch (e) { /* 数字只是展示，失败就保留默认 */ }
  }

  async function load() {
    var resp = await fetch("/api/auth/me", { credentials: "same-origin" });
    var data = await resp.json().catch(function () { return {}; });
    render(data);
  }

  // ---------------------------------------------------------- 邀请码
  // loadInvites 在 render() 里按会员状态调用

  // ---------------------------------------------------------- 标签页
  q("tab-login").addEventListener("click", function () {
    q("tab-login").classList.add("on");
    q("tab-register").classList.remove("on");
    show("f-login", true);
    show("f-register", false);
  });
  q("tab-register").addEventListener("click", function () {
    q("tab-register").classList.add("on");
    q("tab-login").classList.remove("on");
    show("f-register", true);
    show("f-login", false);
  });

  // ---------------------------------------------------------- 登录
  q("f-login").addEventListener("submit", async function (ev) {
    ev.preventDefault();
    var btn = q("b-login");
    var out = q("out-out");
    btn.disabled = true;
    say(out, "正在登录…");
    try {
      var r = await post("/api/auth/login", {
        qq: q("l-qq").value.trim(),
        password: q("l-pw").value
      });
      if (!r.ok) { say(out, MSG[reasonOf(r.data)] || "登录失败，稍后再试。", "err"); return; }
      q("l-pw").value = "";
      say(out, "", "");
      await load();
    } catch (err) {
      say(out, "网络错误，稍后再试。", "err");
    } finally {
      btn.disabled = false;
    }
  });

  // ---------------------------------------------------------- 注册
  q("f-register").addEventListener("submit", async function (ev) {
    ev.preventDefault();
    var btn = q("b-register");
    var out = q("out-out");
    if (q("r-pw").value !== q("r-pw2").value) { say(out, "两次密码不一样。", "err"); return; }
    if (q("r-agree") && !q("r-agree").checked) {
      say(out, "请先勾选并同意《用户协议与免责声明》。", "err");
      q("r-agree").focus();
      return;
    }
    btn.disabled = true;
    say(out, "正在注册…");
    try {
      var r = await post("/api/auth/register", {
        qq: q("r-qq").value.trim(),
        password: q("r-pw").value,
        nick: q("r-nick").value.trim(),
        invite: (q("r-invite") ? q("r-invite").value.trim().toUpperCase() : ""),
        agree: !!(q("r-agree") && q("r-agree").checked)
      });
      if (!r.ok) {
        var why = reasonOf(r.data);
        // 名额满了 / 后台收紧了，才让访客看到并填写邀请码。
        if (why === "invite_required" || why === "register_full") showInviteRow(true);
        say(out, MSG[why] || "注册失败，稍后再试。", "err");
        return;
      }
      q("r-pw").value = "";
      q("r-pw2").value = "";
      say(out, "", "");
      await load();
    } catch (err) {
      say(out, "网络错误，稍后再试。", "err");
    } finally {
      btn.disabled = false;
    }
  });

  // ---------------------------------------------------------- 退出
  q("b-logout").addEventListener("click", async function () {
    await post("/api/auth/logout", {});
    await load();
  });

  // ---------------------------------------------------------- 核销
  q("f-redeem").addEventListener("submit", async function (ev) {
    ev.preventDefault();
    var btn = q("b-redeem");
    var out = q("out-redeem");
    var code = q("d-code").value.trim();
    var qq = q("d-qq").value.trim();
    if (!code || !qq) { say(out, "授权码和 QQ 号都要填。", "err"); return; }
    btn.disabled = true;
    say(out, "正在核销…");
    try {
      var r = await post("/api/sub/redeem-public", { code: code, qq: qq });
      if (!r.ok) { say(out, MSG[reasonOf(r.data)] || "核销失败，检查一下码。", "err"); return; }
      var d = r.data || {};
      say(out, (d.first ? "✅ 首次开通成功：" : "✅ 续期成功：") + "已延长 " + d.days +
        " 天，到期 " + fmt(d.expires_at) + "。回首页刷新即可进入。", "ok");
      q("d-code").value = "";
      await load();
    } catch (err) {
      say(out, "网络错误，稍后再试。", "err");
    } finally {
      btn.disabled = false;
    }
  });

  // ---------------------------------------------------------- 改密码
  q("f-password").addEventListener("submit", async function (ev) {
    ev.preventDefault();
    var btn = q("b-password");
    var out = q("out-password");
    btn.disabled = true;
    say(out, "正在保存…");
    try {
      var r = await post("/api/auth/password", {
        old: q("p-old").value,
        new: q("p-new").value
      });
      if (!r.ok) { say(out, MSG[reasonOf(r.data)] || "改密码失败。", "err"); return; }
      q("p-old").value = "";
      q("p-new").value = "";
      say(out, "✅ 已保存。其它设备上的登录已失效。", "ok");
    } catch (err) {
      say(out, "网络错误，稍后再试。", "err");
    } finally {
      btn.disabled = false;
    }
  });

  async function loadContact() {
    var box = q("contact-box");
    var reg = q("reg-group");
    if (!box && !reg) return;
    try {
      var resp = await fetch("/api/auth/contact", { credentials: "same-origin" });
      if (!resp.ok) return;
      var d = await resp.json();
      var qq = String(d.group_qq || "").trim();
      var link = String(d.group_link || "").trim();
      var note = String(d.note || "").trim() || "加群购买订阅服务";
      if (!qq && !link) { if (box) box.hidden = true; if (reg) reg.hidden = true; return; }
      if (reg) {
        reg.hidden = false;
        var rq = q("reg-group-qq");
        rq.textContent = qq ? "群号 " + qq : "点这里加群";
        rq.href = link || "#";
        if (link) { rq.target = "_blank"; rq.rel = "noopener"; } else { rq.removeAttribute("target"); rq.onclick = function (e) { e.preventDefault(); }; }
        var rc = q("reg-group-copy");
        if (qq) {
          rc.hidden = false;
          rc.onclick = async function () {
            try { await navigator.clipboard.writeText(qq); rc.textContent = "已复制：" + qq; }
            catch (e) { rc.textContent = "手动记：" + qq; }
            setTimeout(function () { rc.textContent = "复制群号"; }, 2500);
          };
        } else { rc.hidden = true; }
        var rj = q("reg-group-join");
        if (link) { rj.hidden = false; rj.href = link; } else { rj.hidden = true; }
      }
      if (!box) return;
      box.hidden = false;
      q("contact-note").textContent = note;
      q("contact-qq").textContent = qq || "点下面的按钮加群";
      var copy = q("contact-copy");
      if (qq) {
        copy.hidden = false;
        copy.onclick = async function () {
          try {
            await navigator.clipboard.writeText(qq);
            copy.textContent = "已复制：" + qq;
          } catch (e) {
            copy.textContent = "复制失败，手动记：" + qq;
          }
          setTimeout(function () { copy.textContent = "复制群号"; }, 2500);
        };
      } else {
        copy.hidden = true;
      }
      var join = q("contact-join");
      if (link) {
        join.href = link;
        join.hidden = false;
      } else {
        join.hidden = true;
      }
    } catch (e) { /* 联系信息只是展示，失败就保持隐藏 */ }
  }

  q("merge-do").addEventListener("click", adoptMember);
  q("merge-skip").addEventListener("click", function () {
    q("merge-banner").hidden = true;
    localStorage.setItem("va-merge-skip", "1");
  });

  loadLimits();
  loadContact();
  load();
})();