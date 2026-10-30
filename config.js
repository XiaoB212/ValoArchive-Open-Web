/* ValoArchive-Open-Web —— 部署时改这里即可，页面本身不用动。
 *
 * apiBase：后端地址（同一个 ValoArchive-Web 后端）。留空表示与页面同源，
 *          例如把静态站点和后端放在同一台机器的 80 端口反代时用空串。
 * apiKey ：后端口令。后端开了口令（data/access_keys.json 或环境变量
 *          VALOARCHIVE_ACCESS_KEY）时必填；命令行 / 插件里那个 key 就是它。
 */
window.VALO_CONFIG = {
  apiBase: "",
  apiKey: ""
};

/* 所有以 "/" 开头的请求（/api/...、/img?...）都转到 apiBase，
 * 因此 app.js 里不需要出现任何后端地址。 */
(function () {
  var native = window.fetch ? window.fetch.bind(window) : null;
  if (!native) return;
  window.fetch = function (input, init) {
    var cfg = window.VALO_CONFIG || {};
    var base = String(cfg.apiBase || "").replace(/\/+$/, "");
    if (typeof input === "string" && input.charAt(0) === "/" && input.indexOf("/static/") !== 0) {
      var url = base + input;
      if (cfg.apiKey) url += (url.indexOf("?") === -1 ? "?" : "&") + "key=" + encodeURIComponent(cfg.apiKey);
      input = url;
    }
    return native(input, init);
  };
})();
