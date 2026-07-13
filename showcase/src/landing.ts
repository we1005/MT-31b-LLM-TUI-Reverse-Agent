import './style/base.css'
import './style/landing.css'

const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches

// 签名动效收束：追踪跑完后，点亮"被篡改的那一行"（朱砂 + 盖章）
const hit = document.querySelector('.trace .hit')
if (hit) {
  if (reduce) hit.classList.add('lit')
  else setTimeout(() => hit.classList.add('lit'), 2450)
}

// 滚动揭幕
const revIO = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        e.target.classList.add('in')
        revIO.unobserve(e.target)
      }
    }
  },
  { threshold: 0.14, rootMargin: '0px 0px -8% 0px' },
)
document.querySelectorAll('.reveal').forEach((el) => revIO.observe(el))

// 数字 count-up
function countUp(el: HTMLElement) {
  const target = Number(el.dataset.count || '0')
  const unit = el.querySelector('.u')?.outerHTML ?? ''
  if (reduce) {
    el.innerHTML = String(target) + unit
    return
  }
  const dur = 1150
  const t0 = performance.now()
  const step = (now: number) => {
    const p = Math.min(1, (now - t0) / dur)
    const v = Math.round((1 - Math.pow(1 - p, 3)) * target)
    el.innerHTML = String(v) + unit
    if (p < 1) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}
const numIO = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        countUp(e.target as HTMLElement)
        numIO.unobserve(e.target)
      }
    }
  },
  { threshold: 0.6 },
)
document.querySelectorAll<HTMLElement>('.num[data-count]').forEach((el) => numIO.observe(el))
