import './style/base.css'
import './style/reader.css'
import 'highlight.js/styles/github.css'
import { renderMarkdown } from './md'
import { registerPWA } from './pwa'
import index from './content/index.json'

// mermaid 懒加载
let mermaidReady: Promise<typeof import('mermaid').default> | null = null
function loadMermaid() {
  if (!mermaidReady) {
    mermaidReady = import('mermaid').then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false, theme: 'base', securityLevel: 'loose',
        fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
        themeVariables: { background: '#ffffff', primaryColor: '#f2f3f6', primaryTextColor: '#14181f', primaryBorderColor: '#3a5a86', lineColor: '#59616e', secondaryColor: '#fdecea', tertiaryColor: '#eef0f3', fontSize: '14px' },
      })
      return mermaid
    })
  }
  return mermaidReady
}

type Entry = { slug: string; title: string; group?: string }
type Kind = 'docs' | 'wiki' | 'tutorial'

const rawDocs = import.meta.glob('./content/docs/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const rawWiki = import.meta.glob('./content/wiki/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const rawTut = import.meta.glob('./content/tutorial/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

const KIND_LABEL: Record<Kind, string> = { docs: '实测文档', wiki: 'Wiki', tutorial: '保姆级教程' }

const slugFromPath = (p: string) => decodeURIComponent(p.split('/').pop() || '').replace(/\.md$/, '')
function bySlug(raws: Record<string, string>) {
  const out: Record<string, string> = {}
  for (const [p, v] of Object.entries(raws)) out[slugFromPath(p)] = v
  return out
}
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)

// 代码块工具条图标 + 下载扩展名
const ICON_COPY = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>'
const ICON_CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>'

export function mountReader(kind: Kind) {
  registerPWA()
  const list = ((index as Record<string, Entry[]>)[kind] || []).filter((e) => e.slug)
  const raws = bySlug(kind === 'docs' ? rawDocs : kind === 'wiki' ? rawWiki : rawTut)
  const app = document.getElementById('app')!

  app.innerHTML = `
    <nav class="rnav">
      <div class="rnav-inner">
        <button id="collapseBtn" class="collapse-btn" title="收起 / 展开 文档列表" aria-label="收起或展开左侧文档列表"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="9" y1="4" x2="9" y2="20"/></svg></button>
        <a class="brand" href="./index.html"><span class="rev">rev</span>-agent</a>
        <div class="rnav-mid">
          <a href="./docs.html" class="${kind === 'docs' ? 'active' : ''}">实测文档</a>
          <a href="./wiki.html" class="${kind === 'wiki' ? 'active' : ''}">Wiki</a>
          <a href="./tutorial.html" class="${kind === 'tutorial' ? 'active' : ''}">保姆级教程</a>
        </div>
        <div class="rnav-right">
          <button id="prefBtn" class="pref-btn" title="阅读设置 · 字体/字号" aria-label="阅读设置"><span style="font-family:var(--font-serif);font-weight:600;font-size:15px;letter-spacing:.5px">Aa</span></button>
          <button id="themeBtn" class="theme-btn" title="切换 Markdown 渲染主题" aria-label="切换渲染主题"><span class="sw"></span><span class="tt">取证</span></button>
          <input id="filter" class="filter" placeholder="过滤 / filter…" autocomplete="off" />
          <button id="menuBtn" class="menu-btn" aria-label="目录">☰</button>
        </div>
      </div>
      <div id="prefPanel" class="pref-panel" hidden>
        <div class="pref-title">阅读设置 · Reading</div>
        <div class="pref-grp">
          <div class="lbl">正文 · 内容(最影响阅读)</div>
          <div class="pref-row"><select id="bodyFont" aria-label="正文字体"></select></div>
          <div class="pref-row"><input id="bodySize" type="range" min="14" max="22" step="0.5" aria-label="正文字号" /><span class="sz" id="bodySizeV"></span></div>
        </div>
        <div class="pref-grp">
          <div class="lbl">左侧 · 文档列表</div>
          <div class="pref-row"><select id="sideFont" aria-label="左侧栏字体"></select></div>
          <div class="pref-row"><input id="sideSize" type="range" min="12" max="18" step="0.5" aria-label="左侧栏字号" /><span class="sz" id="sideSizeV"></span></div>
        </div>
        <div class="pref-grp">
          <div class="lbl">右侧 · 本页大纲</div>
          <div class="pref-row"><select id="tocFont" aria-label="大纲字体"></select></div>
          <div class="pref-row"><input id="tocSize" type="range" min="12" max="18" step="0.5" aria-label="大纲字号" /><span class="sz" id="tocSizeV"></span></div>
        </div>
        <div class="pref-grp">
          <div class="lbl">代码块样式</div>
          <div class="pref-row"><select id="codeStyle" aria-label="代码块样式"></select></div>
        </div>
        <div class="pref-grp">
          <div class="lbl">代码块字体(ASCII 图对齐)</div>
          <div class="pref-row"><select id="codeFont" aria-label="代码块字体"></select></div>
        </div>
        <div class="pref-foot"><span class="pref-hint">自动保存 · 首个为最适阅读</span><button class="pref-reset" id="prefReset">恢复默认</button></div>
      </div>
    </nav>
    <div class="reader">
      <aside id="sidebar" class="sidebar">
        <nav class="side-cross">
          <a href="./docs.html" class="${kind === 'docs' ? 'active' : ''}">实测文档</a>
          <a href="./wiki.html" class="${kind === 'wiki' ? 'active' : ''}">Wiki</a>
          <a href="./tutorial.html" class="${kind === 'tutorial' ? 'active' : ''}">教程</a>
        </nav>
        <div id="sidelist" class="sidelist"></div>
      </aside>
      <div id="scrim" class="scrim"></div>
      <main class="content"><article id="doc" class="md-body"></article><div class="doc-foot">rev-agent · ${kind === 'docs' ? 'docs-resources' : kind === 'tutorial' ? '安卓逆向保姆级教程' : 'wiki'} · 生成于本地实测</div></main>
      <div class="toc-resizer" id="tocResizer" title="拖动调整大纲栏宽度 · 双击重置"></div>
      <aside class="toc-col"><nav id="toc" class="toc"></nav></aside>
    </div>`

  const sidebar = document.getElementById('sidebar')!
  const sidelist = document.getElementById('sidelist')!
  const doc = document.getElementById('doc')!
  const toc = document.getElementById('toc')!
  const filter = document.getElementById('filter') as HTMLInputElement
  const menuBtn = document.getElementById('menuBtn')!
  const scrim = document.getElementById('scrim')!
  const themeBtn = document.getElementById('themeBtn')!
  const content = document.querySelector('.content') as HTMLElement

  /* ── 渲染主题切换（取证 / Vue） ── */
  const applyTheme = (t: string) => {
    document.documentElement.setAttribute('data-md', t)
    try { localStorage.setItem('revmd-theme', t) } catch { /* ignore */ }
    themeBtn.querySelector('.tt')!.textContent = t === 'vue' ? 'Vue' : '取证'
  }
  let savedTheme = 'vue'
  try { savedTheme = localStorage.getItem('revmd-theme') || 'vue' } catch { /* ignore */ }
  applyTheme(savedTheme)
  themeBtn.addEventListener('click', () => applyTheme(document.documentElement.getAttribute('data-md') === 'vue' ? 'forensic' : 'vue'))

  /* ── 页面路由：用 ?p=slug（把 hash 让给页内锚点/大纲） ── */
  const current = (): string => {
    const p = new URLSearchParams(location.search).get('p') || ''
    return raws[p] ? p : list[0]?.slug || ''
  }
  function navigate(slug: string, push = true) {
    if (push) history.pushState({}, '', `?p=${encodeURIComponent(slug)}`)
    render()
    closeMenu()
  }

  /* ── 侧栏（页面列表） ── */
  const linkHtml = (e: Entry) => `<a class="side-link" data-slug="${encodeURIComponent(e.slug)}" href="?p=${encodeURIComponent(e.slug)}">${esc(e.title)}</a>`
  function buildSidebar(q = '') {
    const ql = q.trim().toLowerCase()
    const shown = list.filter((e) => !ql || e.title.toLowerCase().includes(ql) || e.slug.toLowerCase().includes(ql))
    let html = ''
    if (kind === 'docs' || kind === 'tutorial') {
      const groups = new Map<string, Entry[]>()
      for (const e of shown) { const g = e.group || '其它'; (groups.get(g) || groups.set(g, []).get(g)!).push(e) }
      for (const [g, items] of groups) html += `<div class="side-group">${esc(g)}</div>` + items.map(linkHtml).join('')
    } else html = shown.map(linkHtml).join('')
    sidelist.innerHTML = html || `<div class="side-empty">无匹配</div>`
    markActiveSide()
  }
  function markActiveSide() {
    const cur = current()
    sidebar.querySelectorAll('.side-link').forEach((a) => a.classList.toggle('active', decodeURIComponent((a as HTMLElement).dataset.slug || '') === cur))
  }

  /* ── 本页大纲 TOC（h2/h3，滚动高亮） ── */
  let spyHeads: HTMLElement[] = []
  function buildTOC() {
    const heads = Array.from(doc.querySelectorAll<HTMLElement>('h2[id], h3[id]'))
    if (heads.length < 2) { toc.innerHTML = ''; toc.classList.add('empty'); spyHeads = []; return }
    toc.classList.remove('empty')
    toc.innerHTML = heads.map((h) =>
      `<a class="toc-link lvl${h.tagName === 'H3' ? 3 : 2}" href="#${h.id}" data-id="${h.id}">${esc(h.textContent || '')}</a>`).join('')
    spyHeads = heads
    toc.querySelectorAll<HTMLElement>('.toc-link').forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault()
      const el = doc.querySelector<HTMLElement>('#' + CSS.escape(a.dataset.id || ''))
      if (el) { content.scrollTo({ top: el.offsetTop - 20, behavior: 'smooth' }); history.replaceState({}, '', location.pathname + location.search + '#' + a.dataset.id) }
    }))
  }
  function spy() {
    if (!spyHeads.length) return
    const y = content.scrollTop + 90
    let active = spyHeads[0]
    for (const h of spyHeads) { if (h.offsetTop <= y) active = h; else break }
    toc.querySelectorAll('.toc-link').forEach((a) => a.classList.toggle('active', (a as HTMLElement).dataset.id === active.id))
  }

  async function render() {
    const slug = current()
    const raw = raws[slug]
    doc.innerHTML = raw ? renderMarkdown(raw) : '<p>未找到该页面。</p>'
    markActiveSide()
    // 宽表格横向滚动容器
    doc.querySelectorAll('table').forEach((t) => {
      if (t.parentElement?.classList.contains('table-scroll')) return
      const w = document.createElement('div'); w.className = 'table-scroll'; t.replaceWith(w); w.appendChild(t)
    })
    // 代码块窗口化(mermaid 除外):外包 .code-wrap + 顶栏(语言名居中 + 复制/下载图标),按钮固定可视右上角
    doc.querySelectorAll<HTMLElement>('pre.code').forEach((pre) => {
      if (pre.parentElement?.classList.contains('code-wrap')) return
      const codeEl = pre.querySelector('code')
      const langCls = Array.from(codeEl?.classList || []).find((c) => c.startsWith('language-'))
      const lang = langCls ? langCls.slice(9) : (pre.classList.contains('plain') ? '' : '')
      const wrap = document.createElement('div'); wrap.className = 'code-wrap'
      pre.replaceWith(wrap); wrap.appendChild(pre)
      if (lang) { const lb = document.createElement('span'); lb.className = 'code-lang'; lb.textContent = lang; wrap.appendChild(lb) }
      const tools = document.createElement('div'); tools.className = 'code-tools'
      const copy = document.createElement('button')
      copy.type = 'button'; copy.className = 'code-icon'; copy.title = '复制'; copy.setAttribute('aria-label', '复制代码'); copy.innerHTML = ICON_COPY
      copy.addEventListener('click', async () => {
        const text = codeEl?.textContent ?? ''
        let ok = false
        try { await navigator.clipboard.writeText(text); ok = true } catch {
          const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0'
          document.body.appendChild(ta); ta.select()
          try { ok = document.execCommand('copy') } catch { /* ignore */ }
          ta.remove()
        }
        if (ok) { copy.innerHTML = ICON_CHECK; copy.classList.add('done'); copy.title = '已复制' }
        window.setTimeout(() => { copy.innerHTML = ICON_COPY; copy.classList.remove('done'); copy.title = '复制' }, 1400)
      })
      tools.append(copy); wrap.appendChild(tools)
    })
    buildTOC()
    content.scrollTo({ top: 0 })
    spy()
    const blocks = doc.querySelectorAll<HTMLElement>('pre.mermaid')
    if (blocks.length) { try { const m = await loadMermaid(); await m.run({ nodes: Array.from(blocks) }) } catch (err) { console.warn('[mermaid]', err) } }
  }

  /* ── 事件 ── */
  const closeMenu = () => document.body.classList.remove('menu-open')
  sidebar.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest('.side-link') as HTMLElement | null
    if (!a) return
    e.preventDefault(); navigate(decodeURIComponent(a.dataset.slug || ''))
  })
  // 正文里的维基链接（?p=）与相对 .md 交叉链接都走前端路由（否则 [文本](xxx.md) 会跳出 SPA 变 404）
  doc.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest('a') as HTMLAnchorElement | null
    if (!a) return
    const href = a.getAttribute('href') || ''
    if (href.startsWith('?p=')) { e.preventDefault(); navigate(decodeURIComponent(href.slice(3))) }
    else if (!/^(https?:|mailto:|#)/i.test(href) && /\.md(\?|#|$)/i.test(href)) {
      // 相对 .md 链接 → 取文件名去扩展名作 slug，走 ?p= 路由
      e.preventDefault()
      const slug = decodeURIComponent(href.split(/[?#]/)[0].replace(/^.*\//, '').replace(/\.md$/i, ''))
      navigate(slug)
    }
  })
  window.addEventListener('popstate', () => render())
  filter.addEventListener('input', () => buildSidebar(filter.value))
  menuBtn.addEventListener('click', () => document.body.classList.toggle('menu-open'))
  scrim.addEventListener('click', closeMenu)
  content.addEventListener('scroll', () => requestAnimationFrame(spy), { passive: true })

  /* ── 可拖拽分隔条：拖动改变「本页大纲」栏宽度（双击重置，宽度记忆到 localStorage） ── */
  const reader = document.querySelector('.reader') as HTMLElement
  const tocResizer = document.getElementById('tocResizer')
  if (reader && tocResizer) {
    try { const w = localStorage.getItem('revmd-tocw'); if (w) reader.style.setProperty('--toc-w', w) } catch { /* ignore */ }
    let dragging = false, lastW = ''
    const clamp = (x: number) => Math.max(190, Math.min(Math.min(720, window.innerWidth * 0.55), x))
    tocResizer.addEventListener('pointerdown', (e) => {
      dragging = true; document.body.classList.add('toc-resizing')
      try { tocResizer.setPointerCapture((e as PointerEvent).pointerId) } catch { /* ignore */ }
      e.preventDefault()
    })
    tocResizer.addEventListener('pointermove', (e) => {
      if (!dragging) return
      lastW = clamp(window.innerWidth - (e as PointerEvent).clientX) + 'px'
      reader.style.setProperty('--toc-w', lastW)
    })
    const end = (e: Event) => {
      if (!dragging) return
      dragging = false; document.body.classList.remove('toc-resizing')
      try { tocResizer.releasePointerCapture((e as PointerEvent).pointerId) } catch { /* ignore */ }
      try { if (lastW) localStorage.setItem('revmd-tocw', lastW) } catch { /* ignore */ }
    }
    tocResizer.addEventListener('pointerup', end)
    tocResizer.addEventListener('pointercancel', end)
    tocResizer.addEventListener('dblclick', () => {
      reader.style.removeProperty('--toc-w')
      try { localStorage.removeItem('revmd-tocw') } catch { /* ignore */ }
    })
  }

  /* ── 阅读设置:左侧栏 / 本页大纲 的字体与字号(自动保存,首个为最适阅读) ── */
  type FontDef = { id: string; label: string; stack: string; url?: string }
  const FONTS: FontDef[] = [
    { id: 'lxgw', label: '霞鹜文楷 LXGW WenKai · 阅读最佳', stack: "'LXGW WenKai', 'PingFang SC', serif", url: 'https://cdn.jsdelivr.net/npm/lxgw-wenkai-webfont/style.css' },
    { id: 'pingfang', label: '苹方 PingFang SC · 苹果系统', stack: "'PingFang SC', -apple-system, 'Helvetica Neue', sans-serif" },
    { id: 'notosans', label: '思源黑体 Noto Sans SC · 中英俱佳', stack: "'Noto Sans SC', 'PingFang SC', sans-serif", url: 'https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;500&display=swap' },
    { id: 'notoserif', label: '思源宋体 Noto Serif SC · 长文', stack: "'Noto Serif SC', 'Songti SC', serif", url: 'https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;600&display=swap' },
    { id: 'inter', label: 'Inter + 苹方 · 现代 UI', stack: "'Inter', 'PingFang SC', sans-serif", url: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap' },
    { id: 'systemui', label: '系统默认 System UI', stack: "system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif" },
    { id: 'harmony', label: 'HarmonyOS Sans SC', stack: "'HarmonyOS Sans SC', 'PingFang SC', sans-serif", url: 'https://cdn.jsdelivr.net/npm/harmonyos-sans-sc-webfont@1.0.0/style.css' },
    { id: 'jetbrains', label: 'JetBrains Mono · IDEA 编辑器', stack: "'JetBrains Mono', 'PingFang SC', monospace", url: 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap' },
    { id: 'firacode', label: 'Fira Code · 等宽连字', stack: "'Fira Code', 'PingFang SC', monospace" },
    { id: 'plexmono', label: 'IBM Plex Mono', stack: "'IBM Plex Mono', 'PingFang SC', monospace" },
    { id: 'sourcecode', label: 'Source Code Pro', stack: "'Source Code Pro', 'PingFang SC', monospace", url: 'https://fonts.googleapis.com/css2?family=Source+Code+Pro:wght@400;500&display=swap' },
    { id: 'yahei', label: '微软雅黑 Microsoft YaHei · Win', stack: "'Microsoft YaHei', 'PingFang SC', sans-serif" },
    { id: 'songti', label: '宋体 Songti SC · 衬线', stack: "'Songti SC', 'Noto Serif SC', serif" },
  ]
  const injectedFonts = new Set<string>()
  const ensureFont = (id: string) => {
    const f = FONTS.find((x) => x.id === id)
    if (f?.url && !injectedFonts.has(id)) {
      injectedFonts.add(id)
      const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = f.url; document.head.appendChild(l)
    }
  }
  const PREF_DEF = { bodyFont: '', bodySize: '16', sideFont: 'notosans', sideSize: '14.5', tocFont: '', tocSize: '14', codeStyle: 'glasslite', codeFont: 'sarasa' }
  // 代码块字体:[id, 标签, font-family 栈]。前两个自托管(@font-face 常驻,中文=2×西文)。
  const CODE_FONTS: [string, string, string][] = [
    ['sarasa', '更纱黑体等宽 Sarasa Mono · 图对齐最佳(默认)', "'SarasaMonoSC', ui-monospace, 'JetBrains Mono', monospace"],
    ['lxgwmono', '霞鹜文楷等宽 LXGW · 书卷气(框图不齐)', "'LXGWWenKaiMono', ui-monospace, monospace"],
    ['sitemono', '站点原等宽 Fira/Plex · 西文连字(框图不齐)', "'Fira Code', 'IBM Plex Mono', ui-monospace, monospace"],
  ]
  const CODESTYLES: [string, string][] = [
    ['github', 'GitHub 浅色(默认)'], ['onedark', 'One Dark Pro · 深色'], ['dracula', 'Dracula · 吸血鬼'],
    ['catppuccin', 'Catppuccin Mocha · 社区新宠'], ['tokyonight', 'Tokyo Night · 夜东京'], ['nord', 'Nord · 极地蓝'],
    ['monokai', 'Monokai · 经典'], ['macos', 'macOS 终端窗口 · 红黄绿灯'],
    ['glass', '苹果毛玻璃 · 悬浮卡片'], ['glasslite', '苹果毛玻璃 · 素雅(低彩)'], ['synthwave', '霓虹 Synthwave · 赛博'],
  ]
  let prefs = { ...PREF_DEF }
  try { prefs = { ...PREF_DEF, ...JSON.parse(localStorage.getItem('revmd-fontprefs') || '{}') } } catch { /* ignore */ }
  const root = document.documentElement
  const applyPrefs = () => {
    const bf = FONTS.find((x) => x.id === prefs.bodyFont), sf = FONTS.find((x) => x.id === prefs.sideFont), tf = FONTS.find((x) => x.id === prefs.tocFont)
    if (bf) { ensureFont(bf.id); root.style.setProperty('--body-font', bf.stack) } else root.style.removeProperty('--body-font')
    if (sf) { ensureFont(sf.id); root.style.setProperty('--side-font', sf.stack) } else root.style.removeProperty('--side-font')
    if (tf) { ensureFont(tf.id); root.style.setProperty('--toc-font', tf.stack) } else root.style.removeProperty('--toc-font')
    root.style.setProperty('--body-size', prefs.bodySize + 'px')
    root.style.setProperty('--side-size', prefs.sideSize + 'px')
    root.style.setProperty('--toc-size', prefs.tocSize + 'px')
    root.setAttribute('data-codestyle', prefs.codeStyle || 'github')
    const cf = CODE_FONTS.find((x) => x[0] === prefs.codeFont) || CODE_FONTS[0]
    root.style.setProperty('--code-font', cf[2])
  }
  const savePrefs = () => { try { localStorage.setItem('revmd-fontprefs', JSON.stringify(prefs)) } catch { /* ignore */ } }
  const prefBtn = document.getElementById('prefBtn')!
  const prefPanel = document.getElementById('prefPanel') as HTMLElement
  const bodyFontSel = document.getElementById('bodyFont') as HTMLSelectElement
  const sideFontSel = document.getElementById('sideFont') as HTMLSelectElement
  const tocFontSel = document.getElementById('tocFont') as HTMLSelectElement
  const bodySize = document.getElementById('bodySize') as HTMLInputElement
  const sideSize = document.getElementById('sideSize') as HTMLInputElement
  const tocSize = document.getElementById('tocSize') as HTMLInputElement
  const bodySizeV = document.getElementById('bodySizeV')!
  const sideSizeV = document.getElementById('sideSizeV')!
  const tocSizeV = document.getElementById('tocSizeV')!
  const codeStyleSel = document.getElementById('codeStyle') as HTMLSelectElement
  const codeFontSel = document.getElementById('codeFont') as HTMLSelectElement
  const optsHtml = `<option value="">IBM Plex Sans(站点原字体)</option>` + FONTS.map((f) => `<option value="${f.id}">${esc(f.label)}</option>`).join('')
  bodyFontSel.innerHTML = optsHtml; sideFontSel.innerHTML = optsHtml; tocFontSel.innerHTML = optsHtml
  codeStyleSel.innerHTML = CODESTYLES.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')
  codeFontSel.innerHTML = CODE_FONTS.map((cf) => `<option value="${cf[0]}">${esc(cf[1])}</option>`).join('')
  const syncControls = () => {
    bodyFontSel.value = prefs.bodyFont; sideFontSel.value = prefs.sideFont; tocFontSel.value = prefs.tocFont; codeStyleSel.value = prefs.codeStyle; codeFontSel.value = prefs.codeFont
    bodySize.value = prefs.bodySize; sideSize.value = prefs.sideSize; tocSize.value = prefs.tocSize
    bodySizeV.textContent = prefs.bodySize + 'px'; sideSizeV.textContent = prefs.sideSize + 'px'; tocSizeV.textContent = prefs.tocSize + 'px'
  }
  syncControls(); applyPrefs()
  bodyFontSel.addEventListener('change', () => { prefs.bodyFont = bodyFontSel.value; applyPrefs(); savePrefs() })
  sideFontSel.addEventListener('change', () => { prefs.sideFont = sideFontSel.value; applyPrefs(); savePrefs() })
  tocFontSel.addEventListener('change', () => { prefs.tocFont = tocFontSel.value; applyPrefs(); savePrefs() })
  bodySize.addEventListener('input', () => { prefs.bodySize = bodySize.value; bodySizeV.textContent = bodySize.value + 'px'; applyPrefs(); savePrefs() })
  sideSize.addEventListener('input', () => { prefs.sideSize = sideSize.value; sideSizeV.textContent = sideSize.value + 'px'; applyPrefs(); savePrefs() })
  tocSize.addEventListener('input', () => { prefs.tocSize = tocSize.value; tocSizeV.textContent = tocSize.value + 'px'; applyPrefs(); savePrefs() })
  codeStyleSel.addEventListener('change', () => { prefs.codeStyle = codeStyleSel.value; applyPrefs(); savePrefs() })
  codeFontSel.addEventListener('change', () => { prefs.codeFont = codeFontSel.value; applyPrefs(); savePrefs() })
  document.getElementById('prefReset')!.addEventListener('click', () => { prefs = { ...PREF_DEF }; syncControls(); applyPrefs(); savePrefs() })
  prefBtn.addEventListener('click', (e) => { e.stopPropagation(); prefPanel.hidden = !prefPanel.hidden })
  document.addEventListener('click', (e) => {
    const t = e.target as Node
    if (!prefPanel.hidden && !prefPanel.contains(t) && !prefBtn.contains(t)) prefPanel.hidden = true
  })

  /* ── 左侧文档列表可收起(记忆状态,仅宽屏) ── */
  const collapseBtn = document.getElementById('collapseBtn')
  if (collapseBtn && reader) {
    const setCollapsed = (v: boolean) => { reader.classList.toggle('sidebar-collapsed', v); collapseBtn.setAttribute('aria-pressed', String(v)) }
    let collapsed = false
    try { collapsed = localStorage.getItem('revmd-sidecollapsed') === '1' } catch { /* ignore */ }
    setCollapsed(collapsed)
    collapseBtn.addEventListener('click', () => {
      collapsed = !collapsed; setCollapsed(collapsed)
      try { localStorage.setItem('revmd-sidecollapsed', collapsed ? '1' : '0') } catch { /* ignore */ }
    })
  }

  document.title = `rev-agent · ${KIND_LABEL[kind]}`
  buildSidebar()
  render()
}
