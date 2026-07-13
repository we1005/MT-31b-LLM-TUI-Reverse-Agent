import './style/base.css'
import './style/landing.css'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'

gsap.registerPlugin(ScrollTrigger)

const HERO_IN = ['.hero-eye', '.hero-tag', '.hero-sub', '.hero-cta']

function countUp(el: HTMLElement) {
  const target = Number(el.dataset.count || '0')
  const unit = el.querySelector('.u')?.outerHTML ?? ''
  const obj = { v: 0 }
  gsap.to(obj, {
    v: target,
    duration: 1.3,
    ease: 'power2.out',
    onUpdate: () => { el.innerHTML = String(Math.round(obj.v)) + unit },
  })
}
function setFinal(el: HTMLElement) {
  const unit = el.querySelector('.u')?.outerHTML ?? ''
  el.innerHTML = String(Number(el.dataset.count || '0')) + unit
}

const mm = gsap.matchMedia()

/* 尊重 prefers-reduced-motion：直接显形，无动效 */
mm.add('(prefers-reduced-motion: reduce)', () => {
  gsap.set([...HERO_IN, '.hero-title .l', '.scroll-cue', '.ghost', '.reveal'], { clearProps: 'clipPath,transform', opacity: 1 })
  document.querySelector('.needle')?.classList.add('lit')
  document.querySelector('.trace .hit')?.classList.add('lit')
  document.querySelectorAll<HTMLElement>('.num[data-count]').forEach(setFinal)
})

/* 完整编排 */
mm.add('(prefers-reduced-motion: no-preference)', () => {
  // 幽灵层浮现
  gsap.to('.ghost', { opacity: 1, duration: 1.6, ease: 'power2.out', delay: 0.15 })

  // 入场时间线：eyebrow → 标题逐行揭幕 → tag → sub → cta → scroll cue → 点亮针
  gsap.set(HERO_IN, { y: 16 })
  const tl = gsap.timeline({ defaults: { ease: 'power3.out' } })
  tl.to('.hero-eye', { opacity: 1, y: 0, duration: 0.7 }, 0.15)
    .fromTo(
      '.hero-title .l',
      { opacity: 0, yPercent: 16, clipPath: 'inset(0 108% 0 -4%)' },
      { opacity: 1, yPercent: 0, clipPath: 'inset(0 0% 0 -4%)', duration: 1.0, stagger: 0.16, ease: 'expo.out' },
      0.3,
    )
    .to('.hero-tag', { opacity: 1, y: 0, duration: 0.7 }, '-=0.55')
    .to('.hero-sub', { opacity: 1, y: 0, duration: 0.7 }, '-=0.58')
    .to('.hero-cta', { opacity: 1, y: 0, duration: 0.7 }, '-=0.52')
    .to('.scroll-cue', { opacity: 1, duration: 0.8 }, '-=0.3')
    .add(() => document.querySelector('.needle')?.classList.add('lit'), '-=0.25')

  // 鼠标视差（quickTo 平滑），动画 CSS 变量供 .g 的 translate 消费
  const px = gsap.quickTo('.ghost', '--px', { duration: 0.7, ease: 'power2' })
  const py = gsap.quickTo('.ghost', '--py', { duration: 0.7, ease: 'power2' })
  window.addEventListener('pointermove', (e) => {
    px(-(e.clientX / window.innerWidth - 0.5) * 28)
    py(-(e.clientY / window.innerHeight - 0.5) * 28)
  }, { passive: true })

  // 滚动视差：幽灵层随滚动缓慢上移
  gsap.to('.ghost', {
    yPercent: -14, ease: 'none',
    scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true },
  })

  // 分区揭幕：batch 让同屏进入的元素成组 stagger（网格卡片天然成组）
  ScrollTrigger.batch('.reveal', {
    start: 'top 86%',
    onEnter: (els) => gsap.fromTo(els, { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.75, ease: 'power3.out', stagger: 0.08, overwrite: true }),
    once: true,
  })

  // 证据卡：滚到时点亮篡改行
  ScrollTrigger.create({ trigger: '.evi', start: 'top 72%', once: true, onEnter: () => document.querySelector('.trace .hit')?.classList.add('lit') })

  // 结案数字 count-up
  document.querySelectorAll<HTMLElement>('.num[data-count]').forEach((el) =>
    ScrollTrigger.create({ trigger: el, start: 'top 90%', once: true, onEnter: () => countUp(el) }),
  )
})
