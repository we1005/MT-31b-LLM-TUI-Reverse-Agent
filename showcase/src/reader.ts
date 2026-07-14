import './style/base.css'
import './style/reader.css'
import 'highlight.js/styles/github.css'
import { renderMarkdown } from './md'
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
type Kind = 'docs' | 'wiki'

const rawDocs = import.meta.glob('./content/docs/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const rawWiki = import.meta.glob('./content/wiki/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

const slugFromPath = (p: string) => decodeURIComponent(p.split('/').pop() || '').replace(/\.md$/, '')
function bySlug(raws: Record<string, string>) {
  const out: Record<string, string> = {}
  for (const [p, v] of Object.entries(raws)) out[slugFromPath(p)] = v
  return out
}
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)

export function mountReader(kind: Kind) {
  const list = ((index as Record<string, Entry[]>)[kind] || []).filter((e) => e.slug)
  const raws = bySlug(kind === 'docs' ? rawDocs : rawWiki)
  const app = document.getElementById('app')!

  app.innerHTML = `
    <nav class="rnav">
      <div class="rnav-inner">
        <a class="brand" href="./index.html"><span class="rev">rev</span>-agent</a>
        <div class="rnav-mid">
          <a href="./docs.html" class="${kind === 'docs' ? 'active' : ''}">实测文档</a>
          <a href="./wiki.html" class="${kind === 'wiki' ? 'active' : ''}">Wiki</a>
        </div>
        <div class="rnav-right">
          <button id="themeBtn" class="theme-btn" title="切换 Markdown 渲染主题" aria-label="切换渲染主题"><span class="sw"></span><span class="tt">取证</span></button>
          <input id="filter" class="filter" placeholder="过滤 / filter…" autocomplete="off" />
          <button id="menuBtn" class="menu-btn" aria-label="目录">☰</button>
        </div>
      </div>
    </nav>
    <div class="reader">
      <aside id="sidebar" class="sidebar"></aside>
      <div id="scrim" class="scrim"></div>
      <main class="content"><article id="doc" class="md-body"></article><div class="doc-foot">rev-agent · ${kind === 'docs' ? 'docs-resources' : 'wiki'} · 生成于本地实测</div></main>
      <aside class="toc-col"><nav id="toc" class="toc"></nav></aside>
    </div>`

  const sidebar = document.getElementById('sidebar')!
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
  let savedTheme = 'forensic'
  try { savedTheme = localStorage.getItem('revmd-theme') || 'forensic' } catch { /* ignore */ }
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
    if (kind === 'docs') {
      const groups = new Map<string, Entry[]>()
      for (const e of shown) { const g = e.group || '其它'; (groups.get(g) || groups.set(g, []).get(g)!).push(e) }
      for (const [g, items] of groups) html += `<div class="side-group">${esc(g)}</div>` + items.map(linkHtml).join('')
    } else html = shown.map(linkHtml).join('')
    sidebar.innerHTML = html || `<div class="side-empty">无匹配</div>`
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
    toc.innerHTML = '<div class="toc-t">本页大纲</div>' + heads.map((h) =>
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

  document.title = `rev-agent · ${kind === 'docs' ? '实测文档' : 'Wiki'}`
  buildSidebar()
  render()
}
