/* 分享页公共小工具：负载编解码、准星解析与绘制、复制/下载。
 * 目标：不依赖任何后端，分享内容全部塞进 URL 的 # 后面。 */
(function (global) {
  "use strict";

  // ── base64url ──────────────────────────────────────────────────────
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

  function bytesToB64(bytes) {
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
      const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
      out += B64[a >> 2];
      out += B64[((a & 3) << 4) | ((b || 0) >> 4)];
      out += i + 1 < bytes.length ? B64[((b & 15) << 2) | ((c || 0) >> 6)] : "";
      out += i + 2 < bytes.length ? B64[c & 63] : "";
    }
    return out;
  }

  function b64ToBytes(text) {
    const clean = text.replace(/[^A-Za-z0-9\-_]/g, "");
    const out = [];
    let buf = 0, bits = 0;
    for (const ch of clean) {
      const v = B64.indexOf(ch);
      if (v < 0) continue;
      buf = (buf << 6) | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out.push((buf >> bits) & 0xff);
      }
    }
    return new Uint8Array(out);
  }

  async function deflate(bytes) {
    if (typeof CompressionStream === "undefined") return bytes;
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (err) {
      return bytes;
    }
  }

  async function inflate(bytes) {
    if (typeof DecompressionStream === "undefined") return bytes;
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (err) {
      return bytes;
    }
  }

  /** 对象 → base64url（压缩；压缩失败自动退回明文）。 */
  async function pack(obj) {
    const raw = new TextEncoder().encode(JSON.stringify(obj));
    const small = await deflate(raw);
    return "d" + bytesToB64(small);
  }

  /** base64url → 对象；解不开返回 null。 */
  async function unpack(text) {
    const body = String(text || "").replace(/^d/, "");
    if (!body) return null;
    for (const bytes of [await inflate(b64ToBytes(body)), b64ToBytes(body)]) {
      try {
        return JSON.parse(new TextDecoder().decode(bytes));
      } catch (err) {
        /* 继续试下一个 */
      }
    }
    return null;
  }

  const hex2rgba = (hex, alpha) => {
    const clean = String(hex || "").replace(/[^0-9a-fA-F]/g, "");
    if (clean.length === 6) {
      const r = parseInt(clean.slice(0, 2), 16);
      const g = parseInt(clean.slice(2, 4), 16);
      const b = parseInt(clean.slice(4, 6), 16);
      return `rgba(${r},${g},${b},${Number.isFinite(alpha) ? alpha : 1})`;
    }
    const full = clean.padEnd(8, "f");
    // 分享码里的颜色是 RRGGBBAA
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    const a = parseInt(full.slice(6, 8), 16) / 255;
    return `rgba(${r},${g},${b},${Number.isFinite(alpha) ? alpha : a})`;
  };

  const PRESET_COLORS = ["#ffffff", "#00ff00", "#d4ff00", "#00ffff", "#ff00ff", "#ff0000", "#ffff00", "#00ff7f"];

  /** 解析「0;P;c;5;u;FF0000FF;…」这种分号分享码，返回尽量完整的字段。 */
  function parseCrosshair(code) {
    const tokens = String(code || "").split(";").map((t) => t.trim()).filter((t) => t !== "");
    if (!tokens.length) return null;
    const pairs = {};
    for (let i = 0; i + 1 < tokens.length; i += 2) {
      pairs[tokens[i]] = tokens[i + 1];
    }
    const num = (key, fallback) => {
      const v = Number(pairs[key]);
      return Number.isFinite(v) ? v : fallback;
    };
    const colorKey = pairs.c !== undefined ? num("c", 0) : null;
    const color = pairs.u ? hex2rgba(pairs.u, 1) : PRESET_COLORS[colorKey ?? 0] || "#ffffff";
    const dot = pairs.P === "1" || pairs["1b"] === "1";
    // 内线：自定义码常见 0t/0l/0o/0a；团队码常见 d;内部颜色索引…
    const thickness = Math.max(1, num("0t", num("0l", 1)) || 1);
    const length = Math.max(0, num("0l", 2));
    const offset = Math.max(0, num("0o", 2));
    const opacity = Math.min(1, Math.max(0, num("0a", 1)));
    const outline = Math.min(1, Math.max(0, num("o", 0)));
    const movement = Math.min(1, Math.max(0, num("0m", 0)));
    return { tokens, pairs, color, dot, thickness, length, offset, opacity, outline, movement, raw: code };
  }

  /** 在 canvas 上画准星（尽力还原；分享码格式各家不同，画不准时仍给出代码）。 */
  function drawCrosshair(canvas, parsed, options) {
    if (!canvas) return;
    const opts = options || {};
    const dpr = Math.min(global.devicePixelRatio || 1, 2);
    const css = opts.size || 180;
    canvas.width = css * dpr;
    canvas.height = css * dpr;
    canvas.style.width = css + "px";
    canvas.style.height = css + "px";
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, css, css);
    // 背景：游戏里是深色场景
    ctx.fillStyle = opts.background || "#15181d";
    ctx.fillRect(0, 0, css, css);

    const cx = css / 2, cy = css / 2;
    const unit = css / 100; // 以 100 格为基准
    const px = (v) => Math.max(0.5, v * unit);
    const scale = opts.zoom || 1.6; // 让细线看得见

    const thick = px(parsed.thickness * scale);
    const len = px(parsed.length * scale);
    const gap = px(parsed.offset * scale);
    const rgba = parsed.color;
    const alpha = parsed.opacity;

    const paint = (draw) => {
      // 先画黑描边，再画颜色，贴近游戏观感
      if (parsed.outline > 0) {
        ctx.strokeStyle = `rgba(0,0,0,${parsed.outline})`;
        ctx.fillStyle = `rgba(0,0,0,${parsed.outline})`;
        draw(thick + 2, gap, true);
      }
      ctx.strokeStyle = rgba;
      ctx.fillStyle = rgba;
      ctx.globalAlpha = alpha > 0 && alpha <= 1 ? Math.max(alpha, 0.25) : 1;
      draw(thick, gap, false);
      ctx.globalAlpha = 1;
    };

    paint((t, g) => {
      if (!len) return;
      ctx.beginPath();
      ctx.moveTo(cx, cy - g); ctx.lineTo(cx, cy - g - len); // 上
      ctx.moveTo(cx, cy + g); ctx.lineTo(cx, cy + g + len); // 下
      ctx.moveTo(cx - g, cy); ctx.lineTo(cx - g - len, cy); // 左
      ctx.moveTo(cx + g, cy); ctx.lineTo(cx + g + len, cy); // 右
      ctx.lineWidth = t;
      ctx.lineCap = "butt";
      ctx.stroke();
    });

    if (parsed.dot) {
      const r = Math.max(1, px(parsed.thickness * 0.5 * scale));
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    }
    return Promise.resolve(fallbackCopy(text));
  }

  function fallbackCopy(text) {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    try { document.execCommand("copy"); } catch (err) { /* 忽略 */ }
    area.remove();
  }

  global.ShareKit = { pack, unpack, parseCrosshair, drawCrosshair, copyText, hex2rgba };
})(window);