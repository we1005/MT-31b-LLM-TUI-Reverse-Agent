import MarkdownIt from 'markdown-it'
import anchor from 'markdown-it-anchor'
// 只按需注册语言（用 lib/core 而非全量 highlight.js，砍掉 ~190 语言的体积）
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import typescript from 'highlight.js/lib/languages/typescript'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import python from 'highlight.js/lib/languages/python'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import ini from 'highlight.js/lib/languages/ini'
import diff from 'highlight.js/lib/languages/diff'
import markdownLang from 'highlight.js/lib/languages/markdown'
import plaintext from 'highlight.js/lib/languages/plaintext'

for (const [name, lang] of Object.entries({ bash, sh: bash, shell: bash, typescript, ts: typescript, javascript, js: javascript, json, python, py: python, xml, html: xml, yaml, yml: yaml, ini, toml: ini, diff, markdown: markdownLang, md: markdownLang, plaintext, text: plaintext })) {
  if (!hljs.getLanguage(name)) hljs.registerLanguage(name, lang as never)
}

/**
 * 共享 markdown 渲染器。
 * - mermaid 代码块 → <pre class="mermaid">（供 mermaid.run 客户端渲染；escapeHtml 后 textContent 会解码回原文）
 * - 其它代码块 → highlight.js
 * - 标题加锚点（headerLink，便于 TOC/深链）
 */
export const md: MarkdownIt = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false,
  highlight(str, lang) {
    if (lang === 'mermaid') {
      return `<pre class="mermaid">${md.utils.escapeHtml(str)}</pre>`
    }
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<pre class="code"><code class="hljs language-${lang}">${hljs.highlight(str, { language: lang }).value}</code></pre>`
      } catch {
        /* fallthrough */
      }
    }
    return `<pre class="code"><code class="hljs">${md.utils.escapeHtml(str)}</code></pre>`
  },
}).use(anchor, {
  permalink: anchor.permalink.headerLink(),
  slugify: (s: string) => s.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\w一-鿿-]/g, ''),
})

// 外链新窗口打开
const defaultLinkOpen =
  md.renderer.rules.link_open ||
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const href = tokens[idx].attrGet('href') || ''
  if (/^https?:\/\//.test(href)) {
    tokens[idx].attrSet('target', '_blank')
    tokens[idx].attrSet('rel', 'noopener')
  }
  return defaultLinkOpen(tokens, idx, options, env, self)
}
