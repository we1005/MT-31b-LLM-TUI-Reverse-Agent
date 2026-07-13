import './style/base.css'
import './style/reader.css'
import 'highlight.js/styles/github.css'
import { md } from './md'
import index from './content/index.json'

// mermaid 懒加载：仅当页面含图时才动态 import（避免每页背 ~850KB gzip）
let mermaidReady: Promise<typeof import('mermaid').default> | null = null
function loadMermaid() {
  if (!mermaidReady) {
    mermaidReady = import('mermaid').then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        theme: 'base',
        securityLevel: 'loose',
        fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
        themeVariables: {
          background: '#ffffff',
          primaryColor: '#f2f3f6',
          primaryTextColor: '#14181f',
          primaryBorderColor: '#3a5a86',
          lineColor: '#59616e',
          secondaryColor: '#fdecea',
          tertiaryColor: '#eef0f3',
          fontSize: '14px',
        },
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

function slugFromPath(p: string): string {
  return decodeURIComponent(p.split('/').pop() || '').replace(/\.md$/, '')
}
function bySlug(raws: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [p, v] of Object.entries(raws)) out[slugFromPath(p)] = v
  return out
}

export function mountReader(kind: Kind) {
  const list = ((index as Record<string, Entry[]>)[kind] || []).filter((e) => e.slug)
  const raws = bySlug(kind === 'docs' ? rawDocs : rawWiki)
  const app = document.getElementById('app')!

  app.innerHTML = `
    <nav class="rnav">
      <div class="wrap rnav-inner">
        <a class="brand" href="./index.html"><span class="dot"></span><b><span class="rev">rev</span>-agent</b></a>
        <div class="rnav-mid">
          <a href="./docs.html" class="${kind === 'docs' ? 'active' : ''}">实测文档</a>
          <a href="./wiki.html" class="${kind === 'wiki' ? 'active' : ''}">Wiki</a>
        </div>
        <div class="rnav-right">
          <input id="filter" class="filter" placeholder="过滤 / filter…" autocomplete="off" />
          <button id="menuBtn" class="menu-btn" aria-label="目录">☰</button>
        </div>
      </div>
    </nav>
    <div class="reader">
      <aside id="sidebar" class="sidebar glass"></aside>
      <div id="scrim" class="scrim"></div>
      <main class="content"><article id="doc" class="md-body"></article><div class="doc-foot">rev-agent · ${kind === 'docs' ? 'docs-resources' : 'wiki'} · 生成于本地实测</div></main>
    </div>`

  const sidebar = document.getElementById('sidebar')!
  const doc = document.getElementById('doc')!
  const filter = document.getElementById('filter') as HTMLInputElement
  const menuBtn = document.getElementById('menuBtn')!
  const scrim = document.getElementById('scrim')!

  // 侧栏（docs 按 group 分组，wiki 平铺精选序）
  function buildSidebar(q = '') {
    const ql = q.trim().toLowerCase()
    const hit = (e: Entry) => !ql || e.title.toLowerCase().includes(ql) || e.slug.toLowerCase().includes(ql)
    const shown = list.filter(hit)
    let html = ''
    if (kind === 'docs') {
      const groups = new Map<string, Entry[]>()
      for (const e of shown) {
        const g = e.group || '其它'
        if (!groups.has(g)) groups.set(g, [])
        groups.get(g)!.push(e)
      }
      for (const [g, items] of groups) {
        html += `<div class="side-group">${g}</div>`
        html += items.map(link).join('')
      }
    } else {
      html = shown.map(link).join('')
    }
    sidebar.innerHTML = html || `<div class="side-empty">无匹配</div>`
    markActive()
  }
  function link(e: Entry) {
    return `<a class="side-link" data-slug="${encodeURIComponent(e.slug)}" href="#${encodeURIComponent(e.slug)}">${escapeHtml(e.title)}</a>`
  }
  function escapeHtml(s: string) {
    return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)
  }
  function markActive() {
    const cur = current()
    sidebar.querySelectorAll('.side-link').forEach((a) => {
      a.classList.toggle('active', decodeURIComponent((a as HTMLElement).dataset.slug || '') === cur)
    })
  }
  function current(): string {
    const h = decodeURIComponent(location.hash.replace(/^#/, ''))
    return raws[h] ? h : list[0]?.slug || ''
  }

  async function render() {
    const slug = current()
    const raw = raws[slug]
    if (!raw) {
      doc.innerHTML = `<p>未找到该页面。</p>`
      return
    }
    doc.innerHTML = md.render(raw)
    markActive()
    // 宽表格包一层横向滚动容器，页面本身不横滚
    doc.querySelectorAll('table').forEach((t) => {
      if (t.parentElement?.classList.contains('table-scroll')) return
      const wrap = document.createElement('div')
      wrap.className = 'table-scroll'
      t.replaceWith(wrap)
      wrap.appendChild(t)
    })
    document.querySelector('.content')?.scrollTo({ top: 0 })
    // 渲染 mermaid
    const blocks = doc.querySelectorAll<HTMLElement>('pre.mermaid')
    if (blocks.length) {
      try {
        const mermaid = await loadMermaid()
        await mermaid.run({ nodes: Array.from(blocks) })
      } catch (err) {
        console.warn('[mermaid]', err)
      }
    }
  }

  // 事件
  window.addEventListener('hashchange', () => {
    render()
    closeMenu()
  })
  filter.addEventListener('input', () => buildSidebar(filter.value))
  menuBtn.addEventListener('click', () => document.body.classList.toggle('menu-open'))
  scrim.addEventListener('click', closeMenu)
  sidebar.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.side-link')) closeMenu()
  })
  function closeMenu() {
    document.body.classList.remove('menu-open')
  }

  document.title = `rev-agent · ${kind === 'docs' ? '实测文档' : 'Wiki'}`
  buildSidebar()
  render()
}
