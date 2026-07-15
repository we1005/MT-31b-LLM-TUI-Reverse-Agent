import { chromium } from 'playwright'
import fs from 'node:fs'
const BASE = 'http://localhost:4173'
const OUT = '/Volumes/zhitai-7100/reverse-agent/_scratch/showcase-qa'
fs.mkdirSync(OUT, { recursive: true })
const pages = [['index','/index.html'],['docs','/docs.html'],['wiki','/wiki.html'],['tutorial','/tutorial.html']]
const vps = [['desktop',1280,800],['mobile',390,844]]
const browser = await chromium.launch({ channel: 'chrome' })
const report = []
for (const [name, path] of pages) {
  for (const [vp, w, h] of vps) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: vp === 'mobile' ? 2 : 1 })
    const page = await ctx.newPage()
    const errs = [], failed = []
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0,200)) })
    page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message.slice(0,200)))
    page.on('requestfailed', (r) => { const u=r.url(); if(!u.includes('fonts.g')) failed.push(u.replace(BASE,'')+' :: '+(r.failure()?.errorText||'')) })
    await page.goto(BASE + path, { waitUntil: 'load', timeout: 25000 })
    await page.waitForTimeout(1400)
    const extra = {}
    if (name === 'tutorial') {
      extra.sideGroups = await page.$$eval('.side-group', (els) => els.map((e) => e.textContent))
      extra.sideLinks = await page.$$eval('.side-link', (els) => els.length)
      extra.navLinks = await page.$$eval('.rnav-mid a', (els) => els.map((e) => e.textContent.trim()))
      extra.h1 = await page.$eval('#doc h1', (e) => e.textContent).catch(() => null)
      extra.bodyScrollX = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    }
    if (name === 'index') extra.navLinks = await page.$$eval('.nav-links a', (els) => els.map((e) => e.textContent.trim()))
    extra.overflowX = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2)
    await page.screenshot({ path: `${OUT}/${name}-${vp}.png`, fullPage: false })
    report.push({ page: name, vp, errs, failed, ...extra })
    await ctx.close()
  }
}
const p = await (await browser.newContext()).newPage()
const man = await p.goto(BASE + '/manifest.webmanifest').then(r=>r.status()).catch(()=>'ERR')
const sw = await p.goto(BASE + '/sw.js').then(r=>r.status()).catch(()=>'ERR')
const ic = await p.goto(BASE + '/icons/icon-192.png').then(r=>r.status()).catch(()=>'ERR')
console.log(JSON.stringify({ report, pwa: { manifest: man, sw, icon192: ic } }, null, 2))
await browser.close()
