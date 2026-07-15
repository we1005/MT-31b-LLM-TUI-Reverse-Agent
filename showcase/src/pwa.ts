// PWA: 仅在生产环境注册 Service Worker（避免 dev 期缓存困扰）。
export function registerPWA() {
  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch((e) => console.warn('[pwa] SW register failed', e))
    })
  }
}
