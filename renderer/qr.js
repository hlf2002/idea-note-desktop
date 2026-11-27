/**
 * renderer/qr.js —— qz CLI 终端二维码 → 精确 SVG 渲染
 *
 * 背景：`qz auth login` 用 qrcode-terminal 的 small 模式在终端打印二维码（每 2 个模块合成
 * 一张半块字符）。直接把这些字符放进 <pre> 显示时，模块是否正方取决于字体度量
 * （等宽字符宽 ≈0.6em、line-height 需精确 1.2em），实测截图用 OpenCV 解码失败——
 * 手机扫码不可靠。这里改成解析字符矩阵 → 用 SVG 按固定像素画每个模块：
 * 模块尺寸、静区、对比度都是精确的，扫码器一定可识别。
 *
 * qrcode-terminal small 模式的字符是「反色」的（源码 platte）：
 *   '█' = 上下都白    ' ' = 上下都黑
 *   '▀' = 上白下黑    '▄' = 上黑下白
 * 结构：第 0 行是顶部边框（整行同一字符），每个数据行首尾各 1 个静区字符；
 * 模块数为奇数时末尾补一行全白（解析时丢掉）。
 *
 * 纯函数，主进程/渲染层/单测共用（node 环境走 module.exports）。
 */
(function (root) {
  'use strict';

  /** 半块字符 -> [上模块, 下模块]（1 = 黑） */
  var CHAR_MAP = {
    '\u2588': [0, 0], // █ 上下都白
    ' ': [1, 1],      // 空格 上下都黑
    '\u2580': [0, 1], // ▀ 上白下黑
    '\u2584': [1, 0]  // ▄ 上黑下白
  };

  /**
   * 把 qz CLI 的终端二维码解析成模块矩阵（1 = 黑）。
   * @param {string} text 终端输出的二维码块
   * @returns {number[][]|null} N×N 矩阵；不是方阵/含未知字符返回 null
   */
  function parseTerminalQr(text) {
    var lines = String(text == null ? '' : text).split('\n').filter(function (l) { return l.length > 0; });
    if (lines.length < 3) return null;

    // 顶部边框行：整行只有同一个字符（qrcode-terminal 的 borderTop 全是 '▄'）
    var first = lines[0];
    var isBorder = true;
    for (var i = 1; i < first.length; i += 1) {
      if (first.charAt(i) !== first.charAt(0)) { isBorder = false; break; }
    }
    if (isBorder) lines = lines.slice(1);

    var rows = [];
    for (var li = 0; li < lines.length; li += 1) {
      var body = lines[li];
      // 首尾各 1 个静区字符（'█' = 白）；裁掉后是 moduleCount 个模块
      if (body.charAt(0) === '\u2588') body = body.slice(1);
      if (body.charAt(body.length - 1) === '\u2588') body = body.slice(0, -1);
      if (!body.length) continue;
      var top = [];
      var bottom = [];
      for (var ci = 0; ci < body.length; ci += 1) {
        var m = CHAR_MAP[body.charAt(ci)];
        if (!m) return null; // 未知字符：不是二维码块
        top.push(m[0]);
        bottom.push(m[1]);
      }
      rows.push(top, bottom);
    }

    // 奇数模块数时末尾补的全白行丢掉
    while (rows.length > 1 && rows[rows.length - 1].every(function (v) { return v === 0; })) {
      rows.pop();
    }
    if (!rows.length) return null;
    var n = rows[0].length;
    if (rows.length !== n) return null; // 必须方阵
    return rows;
  }

  /**
   * 模块矩阵 → SVG 字符串（黑模块按行合并成 rect，节点数可控）。
   * @param {number[][]} matrix
   * @param {{moduleSize?: number, quiet?: number}} [opts] 每模块像素、四周静区模块数
   * @returns {string}
   */
  function toSvg(matrix, opts) {
    var moduleSize = (opts && Number(opts.moduleSize)) > 0 ? Number(opts.moduleSize) : 8;
    var quiet = (opts && opts.quiet != null) ? Number(opts.quiet) : 4;
    var n = matrix.length;
    var size = (n + quiet * 2) * moduleSize;
    var rects = [];
    for (var r = 0; r < n; r += 1) {
      for (var c = 0; c < n; c += 1) {
        if (!matrix[r][c]) continue;
        var end = c;
        while (end + 1 < n && matrix[r][end + 1]) end += 1;
        rects.push(
          '<rect x="' + ((c + quiet) * moduleSize) + '" y="' + ((r + quiet) * moduleSize) +
          '" width="' + ((end - c + 1) * moduleSize) + '" height="' + moduleSize + '"/>'
        );
        c = end;
      }
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size +
      '" viewBox="0 0 ' + size + ' ' + size + '" shape-rendering="crispEdges" role="img"' +
      ' aria-label="Q助理 登录二维码">' +
      '<rect width="100%" height="100%" fill="#ffffff"/>' +
      '<g fill="#000000">' + rects.join('') + '</g></svg>';
  }

  /**
   * 终端二维码 → SVG（解析失败返回 ''，调用方降级为纯文本显示）
   * @param {string} text
   * @param {{moduleSize?: number, quiet?: number}} [opts]
   * @returns {string}
   */
  function render(text, opts) {
    var matrix = parseTerminalQr(text);
    if (!matrix) return '';
    return toSvg(matrix, opts);
  }

  var api = { parseTerminalQr: parseTerminalQr, toSvg: toSvg, render: render, CHAR_MAP: CHAR_MAP };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.QrCode = api;
})(typeof window !== 'undefined' ? window : globalThis);
