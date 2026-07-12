export const meta = {
  name: 'device-info-frontanalysis',
  description: '强模型前置分析:定位 Device_Info Premium mod 的混淆破解点，产出 case-file 供 pi-agent(本地弱模型)续分析',
  phases: [
    { title: 'Hunt', detail: '多角度并行搜 Device_Info 混淆破解点' },
    { title: 'CaseFile', detail: '综合成 case-file(候选破解点+去混淆图+待验证链)' },
  ],
}
const HUNT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['findings', 'notes'],
  properties: {
    findings: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['claim', 'file_line', 'confidence'],
      properties: { claim: { type: 'string' }, file_line: { type: 'string', description: '相对 sources 的 文件:行' }, confidence: { type: 'string', enum: ['high','medium','low'] } } } },
    notes: { type: 'string' },
  },
}
const CASE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['case_markdown', 'top_crack_point', 'confidence'],
  properties: {
    case_markdown: { type: 'string', description: 'case-file 正文(markdown):候选破解点(file:line)+去混淆类映射+调用链假设+pi 待验证清单' },
    top_crack_point: { type: 'string', description: '最可能的破解点 类.方法 + file:line' },
    confidence: { type: 'string', enum: ['high','medium','low'] },
  },
}
const ROOT = '/Volumes/zhitai-7100/reverse-agent/apk-moded/device-jadx/sources'
const CTX = `目标:Device Info Premium(包 com.ytheekshana.deviceinfo)的**被破解 mod 版**,反编译源码在 ${ROOT}。主包类名清晰(App/DonateActivity/SettingsActivity...),但付费/pro 判定藏在混淆的 defpackage/ 里(lh2/y60/gn1/l04/p62/w60 等匹配过 billing/purchase)。Device Info Pro 用"donate/pro"解锁(去广告+解锁 sensor/export 等)。任务:定位 mod 版是如何绕过 pro 校验的(哪处方法被 patch 成恒真/校验被短路/billing 结果被伪造)。只读分析,给 file:line 证据。`

phase('Hunt')
const ANGLES = [
  { k: 'consume', p: '搜"pro 状态在哪被消费/判定":grep 去广告、解锁功能、DonateActivity、SettingsActivity 里 if 判某 boolean 决定是否 pro 的地方,反查那个 boolean 来自哪个方法/字段。给 file:line。' },
  { k: 'billing', p: '精读匹配过 billing/purchase 的 defpackage 类(lh2/y60/gn1/l04/p62/w60 等):找 BillingClient purchase 校验、queryPurchases、isPurchased/onPurchasesUpdated 被 stub 或恒真的地方。给 file:line。' },
  { k: 'const-true', p: '搜典型 mod 特征:方法体先读 prefs/billing 结果却丢弃、然后无条件 return true/return 1;或 signature/license 校验被删被短路;或某 static boolean pro 字段被初始化成 true。全 sources 找。给 file:line。' },
  { k: 'ads-gate', p: '搜广告门禁(Device Info Pro 主要卖点=去广告):grep AdView/MobileAds/isAdsRemoved/shouldShowAd,看去广告是不是靠同一个 pro 布尔,反查该布尔的赋值/判定点(mod 常在这恒真)。给 file:line。' },
]
const hunt = await parallel(ANGLES.map((a) => () =>
  agent(`${CTX}\n\n【角度】${a.p}\n\n用 Read/Grep/Glob 实际读 ${ROOT} 下文件。只报真读到的 file:line,标 confidence;找不到诚实说。`,
    { label: `hunt:${a.k}`, phase: 'Hunt', schema: HUNT_SCHEMA })))

phase('CaseFile')
const hj = JSON.stringify(hunt.filter(Boolean))
const caseFile = await agent(
  `综合下列并行搜索结果,产出一份**给本地弱模型(pi+Qwen3.6)续分析用的 case-file**(markdown)。它自己单跑这题会因"混淆无 grep 锚点"而超时空答;你的 case-file 要把它缺的"锚点"补上。\n\n${CTX}\n\n【搜索结果 JSON】\n${hj}\n\n case_markdown 必须含:\n1. **最可能的破解点**(类.方法 + file:line, 按置信度排序)。\n2. **去混淆映射**:defpackage 短名 → 它实际是什么(billing helper / pro 判定 / 广告控制)。\n3. **调用链假设**:从功能/UI 到破解点的链(带 file:line)。\n4. **给 pi 的待验证清单**:让 pi 去 read 哪几个具体文件的哪几行来"确认"破解点(把它从"搜索"降级为"核对"——这是弱模型能做的)。\n诚实:没定位到就说明"未定位到确切点,只给候选方向",不编造 file:line。`,
  { label: 'casefile', phase: 'CaseFile', schema: CASE_SCHEMA, effort: 'high' })

return { case_markdown: caseFile?.case_markdown ?? '', top_crack_point: caseFile?.top_crack_point ?? '', confidence: caseFile?.confidence ?? 'low',
  hunt_high: hunt.filter(Boolean).flatMap(h => (h.findings||[]).filter(f=>f.confidence==='high')).map(f=>f.file_line+' :: '+f.claim).slice(0,10) }
