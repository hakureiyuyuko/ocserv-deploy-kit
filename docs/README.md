# 面板在线演示（GitHub Pages）

这个目录里是给 GitHub Pages 用的静态演示页：**只有前端 + 本地 mock 接口**，没有任何后端，
所有数据都是虚构示例，点任何按钮都不会影响真实服务器。

- `index.html` —— 生成产物，**不要手改**（下次生成会被覆盖）
- 生成方式：在套件根目录执行 `node tools/make-demo.mjs`（源头是 `ocserv-panel/public/index.html` + `tools/demo-mock.js`）

## 开启方式

仓库 → Settings → Pages → Source: `Deploy from a branch`，Branch 选 `main`、目录选 `/docs`，保存即可。
地址形如 `https://<用户名>.github.io/<仓库名>/`。
