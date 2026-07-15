# 部署状态存档 & 迁移 TODO（Netlify 额度耗尽 → Cloudflare Pages）

> 存档日期：2026-07-15　·　决策：**暂不部署,以后迁 Cloudflare Pages**（用户定）
> 站点：https://reverse-agent-for-small-llm.netlify.app/ （Netlify site id `085c245e-79a4-489f-b927-89d6fa955222`,连 GitHub `we1005/MT-31b-LLM-TUI-Reverse-Agent`）

---

## 0. 一句话现状
代码**全部就绪并已 push 到 main**（教程子模块 + 响应式修复 + PWA + 首页入口区),本地 `npm run build` + Playwright 自测全绿;**唯一卡点是 Netlify 账号构建额度耗尽,线上停在旧版本**。不是代码问题,无需改任何代码即可上线——换个能构建的托管(或补 Netlify 额度)即可。

## 1. 根因（已确证）
- `netlify api listSiteDeploys` 显示最近 8 次(含 `0125c5c`/`c0b40cb`/`951757a`/… 一路到 `f6dad80`)deploy **全部 `state=error`**。
- 最新 deploy 的 `error_message` 原文:**`Skipped due to account credit usage exceeded`**（Shanda 团队构建额度用尽 → 每次 GitHub push 触发的构建被直接跳过）。
- **GitHub 自动部署本身是配好的**（站点已连仓库),只是 Netlify 不给跑构建。
- **手动 CLI 部署也不行**:`netlify deploy --prod --dir=dist`(即使已 `netlify link`)返回 `JSONHTTPError: Forbidden`——账号被额度状态锁死,连"上传预构建产物"这条不吃构建分钟的路也被挡。
- 连带症状(同一根因):`/tutorial.html` 404、首页看不到教程入口、**PWA 无安装标志**——都是因为线上是旧版(旧版没有 tutorial 页 / 入口区 / manifest / SW)。**新版一旦真上线,这三样自动都好**。

## 2. 已完成、等待上线的内容（都在 main,commit ≤ `0125c5c`）
- **教程子模块**:`docs-resources/安卓逆向保姆级教程/`（00 总纲 + 01–14,15 篇）;showcase 新增 `tutorial.html`+`src/tutorial.ts`,`reader.ts` 支持 `tutorial` kind,`collect-content.mjs` 采集并按 00–14 分 5 部排序;顶栏「保姆级教程」页签。
- **首页入口区**:`index.html` HERO 下新增 `#start` 区,3 张 portal 卡片(保姆级教程[新]/实测文档/Wiki);hero CTA + 顶栏也有入口。
- **响应式**:`reader.css` 手机端(≤620px)顶栏收窄、跨栏导航移入抽屉 `.side-cross`;Playwright 实测 8 组视口 `overflowX` 全 false、0 console error。
- **PWA**:`public/manifest.webmanifest` + `public/sw.js`（导航 network-first / 静态 SWR / 离线回退）+ `public/icons/`（192/512/maskable,rsvg 生成）+ `src/pwa.ts`（仅 PROD 注册 SW）;4 页 head 加 manifest/apple-touch/viewport-fit。本地 preview 实测 manifest/sw/icon 均 200。
- **netlify.toml**:补了 `/tutorial → /tutorial.html` 200 重写（原只有 docs/wiki）。
- **自测脚本**:`showcase/scripts/qa.mjs`（Playwright channel:chrome,截图 + 断言）。

## 3. TODO：迁移到 Cloudflare Pages（免费额度充足,不吃 Netlify）
### 3.1 CF Pages 项目设置（连 GitHub 仓库自动构建）
- **Connect to Git** → 选仓库 `we1005/MT-31b-LLM-TUI-Reverse-Agent`,分支 `main`。
- **Build settings**:
  - **Root directory（重要）**：`rev-agent/showcase`（对应 Netlify 的 `base=showcase`;仓库根不是 showcase,注意层级——仓库根其实是 `rev-agent/`?按实际仓库结构填,保证 root 下有 `package.json`）。
  - **Build command**：`npm run build`
  - **Build output directory**：`dist`
  - **Environment variable**：`NODE_VERSION = 20`（与 netlify.toml 一致）。
- collect 脚本对缺失的 wiki 源目录有容错(复用已提交 `src/content/` 快照);`docs-resources/` 在仓库内,tutorial/docs 会现采集。**CF 构建应能直接跑通**（与本地 `npm run build` 等价)。

### 3.2 必须补:pretty-URL 重写（CF 不读 netlify.toml!）
Netlify 的 `[[redirects]]`（/docs、/wiki、/tutorial → *.html 200）**Cloudflare 不认**。改用 CF 的 `_redirects` 文件(放进构建输出根,即 `showcase/public/_redirects`,会被复制进 `dist/`):
```
/docs       /docs.html       200
/wiki       /wiki.html       200
/tutorial   /tutorial.html   200
```
（`.html` 直链本来就能访问,`_redirects` 只是补 pretty URL。也可省略,让站内链接都用 `.html`——本项目链接本就带 `.html`,所以即使不加 `_redirects` 也能正常跑,只是 `/tutorial` 这种不带后缀的进不去。**建议加**。）
> netlify.toml 的 `[[headers]]`(X-Content-Type-Options / assets 强缓存)如需保留,CF 用 `public/_headers` 文件表达。

### 3.3 PWA / base 注意点（大概率无需改）
- `vite base:'./'` + PWA 资源用相对路径(`./manifest.webmanifest`、`sw.js`、`./icons/…`)、manifest 内 `start_url/scope` 相对——**CF Pages 根域部署下均正确**,SW 作用域 `/` 正常。
- SW 仅 `import.meta.env.PROD` 注册,CF 构建产物即 PROD,行为一致。

### 3.4 上线后验收清单
- [ ] `/`、`/docs`、`/wiki`、`/tutorial` 均 200,顶栏 3 页签 + 首页 `#start` 入口区可见。
- [ ] 手机视口无横向溢出、抽屉跨栏导航可用。
- [ ] Chrome 地址栏出现 **PWA 安装图标**(DevTools → Application → Manifest 无报错、Service Workers 已激活)。
- [ ] `manifest.webmanifest` / `sw.js` / `icons/icon-192.png` 均 200。
- [ ] 断网二次访问仍可打开(SW 离线回退)。
- 可复跑 `showcase/scripts/qa.mjs`(改 BASE 为线上域名)做回归。

## 4. 备选路径
- **A · 修 Netlify 额度**（最省事,零改动）：Netlify 后台给 Shanda 团队补 build credits / 升套餐,或等月度额度重置;然后 push 或后台 "Trigger deploy" 一次即上线。现有 `.netlify.app` 地址不变。
- **B · GitHub Pages**：加 GH Actions（build showcase → 发布 Pages）,免费不吃 Netlify;换 `*.github.io` 地址,需仓库 Settings 开 Pages + 同样用 `_redirects`/404 兼容多页。
- **C · Cloudflare Pages**：见 §3（用户选定的方向）。

> 触发命令备忘(需 Netlify 额度恢复后,或迁移后无需):当前站已 `netlify link` 到本地 `showcase/.netlify/`(已 gitignore)。额度恢复后 `netlify deploy --prod --dir=dist` 或后台 Trigger deploy 即可。
