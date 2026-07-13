# rev-agent showcase（Netlify 展示站）

暗色「终端夜」× 苹果毛玻璃风格的展示站。三块：

- **落地页** `index.html` — Hero + 设计铁律 + 六大核心机制 + 实测标定(count-up) + 头对头对比 + 端到端架构 + tech marquee。极光 mesh 背景 + 滚动揭幕动效。
- **实测文档** `docs.html` — 直接浏览 `docs-resources/*.md`（按主题分组侧栏 + 过滤 + 高亮代码）。
- **Wiki** `wiki.html` — `_scratch/wiki/*.md` 的美观化 HTML，**Mermaid 图客户端渲染**（暗色主题、懒加载）。

## 技术

Vite（多页）+ 原生 TS + markdown-it(+anchor) + highlight.js(按需语言) + mermaid(懒加载)。无框架、无后端。字体 Fraunces / Inter / JetBrains Mono。

## 本地开发 / 构建

```bash
cd showcase
npm install                 # 若遇 npm 缓存权限，加 --cache <可写目录>
npm run dev                 # 本地开发（先跑 collect 采集内容）
npm run build               # 产物 → dist/
npm run preview             # 预览 dist
```

`npm run collect` 会把 `../docs-resources/*.md` 与 `../../_scratch/wiki/*.md` 复制进 `src/content/`
并生成 `index.json`（标题/分组/精选序）。源目录缺失时容错、复用已提交快照。
**`src/content/` 是内容快照，已提交**，因此仓库单独 clone 也能构建。

## 部署 Netlify

```bash
# 本地构建 + 手动部署（推荐）
npm run build
netlify deploy --prod --dir=dist
```

或连 GitHub 自动部署：`netlify.toml` 的 `base=showcase / command=npm run build / publish=dist` 已配好。

## 更新内容

改了 `docs-resources/` 或 wiki 后，重跑 `npm run build`（内含 collect）即可刷新快照并重新构建。
