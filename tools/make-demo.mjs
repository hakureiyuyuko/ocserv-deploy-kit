#!/usr/bin/env node
/* ============================================================================
 *  生成 GitHub Pages 用的「面板在线演示」单页
 *
 *  做法：把真实面板的前端（ocserv-panel/public/index.html）原样拿来，
 *        只在它前面插一层 mock 接口（tools/demo-mock.js），
 *        再补一个"演示环境"横条，输出成自包含的 docs/index.html。
 *  这样演示页和真实界面永远同源，改了面板重跑一次即可。
 *
 *  用法: node tools/make-demo.mjs        (在套件根目录执行)
 * ==========================================================================*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_HTML = path.join(ROOT, 'ocserv-panel/public/index.html');
const MOCK_JS = path.join(ROOT, 'tools/demo-mock.js');
const OUT_DIR = path.join(ROOT, 'docs');
const REPO_URL = 'https://github.com/hakureiyuyuko/ocserv-deploy-kit';

const DEMO_CSS = `
  /* ---- 在线演示专用（生成时注入，不影响真实面板）---- */
  #demoBar{position:fixed;left:12px;bottom:12px;z-index:120;display:flex;gap:8px;align-items:center;flex-wrap:wrap;
    max-width:min(780px,calc(100vw - 24px));background:var(--panel);border:1px solid var(--line);
    border-left:3px solid var(--acc);border-radius:10px;padding:9px 12px;font-size:12.5px;color:var(--dim);box-shadow:var(--shadow)}
  #demoBar b{color:var(--fg)}
  #demoBar code{background:var(--panel2);border:1px solid var(--line);border-radius:5px;padding:1px 5px;color:var(--fg)}
  #demoBar .demoMini{padding:3px 9px;font-size:12px;border-radius:6px;text-decoration:none;color:var(--fg);
    background:var(--panel2);border:1px solid var(--line);cursor:pointer;font:inherit}
  #demoBar a.demoMini:hover,#demoBar button.demoMini:hover{filter:brightness(1.1)}
  #demoBar .demoSep{opacity:.5}
  @media (max-width:640px){#demoBar{font-size:12px;padding:8px 10px;gap:6px}}
`;

const DEMO_BAR = `
<div id="demoBar">
  <b>在线演示</b>
  <span class="demoSep">·</span>
  <span>数据全是虚构示例，点任何按钮都不会影响真实服务器</span>
  <span class="demoSep">·</span>
  <span>登录 <code>admin / admin</code></span>
  <span class="demoSep">·</span>
  <span>v<span id="demoVer">…</span></span>
  <button class="btn gray demoMini" id="demoReset" type="button">重置演示</button>
  <a class="demoMini" href="${REPO_URL}" target="_blank" rel="noopener">源码 / 安装包</a>
</div>
`;

function fail(msg) { console.error('[make-demo] ' + msg); process.exit(1); }

let html = fs.readFileSync(SRC_HTML, 'utf8');
const mock = fs.readFileSync(MOCK_JS, 'utf8');

if (html.indexOf('<title>ocserv 管理面板</title>') < 0) fail('找不到 <title>，面板首页结构变了？');
if (html.indexOf('</style>') < 0) fail('找不到 </style>');
if (html.lastIndexOf('<script>') < 0) fail('找不到应用脚本块');

html = html.replace(
  '<title>ocserv 管理面板</title>',
  '<title>ocserv 管理面板 · 在线演示</title>\n' +
  '<meta name="description" content="ocserv(OpenConnect/AnyConnect) 管理面板在线演示：数据为虚构示例，可直接点开关、加用户、走配置向导，无需安装。">\n' +
  '<meta name="color-scheme" content="light dark">'
);
html = html.replace('</style>', DEMO_CSS + '</style>');

// mock 必须在应用脚本之前执行（应用一开始就发 /api/meta 与 /api/me）
const appIdx = html.lastIndexOf('<script>');
html = html.slice(0, appIdx) +
  '<script>\n/* ==== 以下为在线演示的 mock 接口层（由 tools/make-demo.mjs 注入，非真实后端）==== */\n' +
  mock + '\n</script>\n' + html.slice(appIdx);

html = html.replace('</body>', DEMO_BAR + '</body>');

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'index.html'), html);
fs.writeFileSync(path.join(OUT_DIR, '.nojekyll'), '');   // 别让 GitHub Pages 走 Jekyll 处理
fs.writeFileSync(path.join(OUT_DIR, 'README.md'),
  '# 面板在线演示（GitHub Pages）\n\n' +
  '这个目录里是给 GitHub Pages 用的静态演示页：**只有前端 + 本地 mock 接口**，没有任何后端，\n' +
  '所有数据都是虚构示例，点任何按钮都不会影响真实服务器。\n\n' +
  '- `index.html` —— 生成产物，**不要手改**（下次生成会被覆盖）\n' +
  '- 生成方式：在套件根目录执行 `node tools/make-demo.mjs`（源头是 `ocserv-panel/public/index.html` + `tools/demo-mock.js`）\n\n' +
  '## 开启方式\n\n' +
  '仓库 → Settings → Pages → Source: `Deploy from a branch`，Branch 选 `main`、目录选 `/docs`，保存即可。\n' +
  '地址形如 `https://<用户名>.github.io/<仓库名>/`。\n'
);

const kb = (Buffer.byteLength(html) / 1024).toFixed(1);
console.log('[make-demo] 已生成 docs/index.html (' + kb + ' KB, 自包含单文件)');
console.log('[make-demo] 已生成 docs/.nojekyll 与 docs/README.md');
