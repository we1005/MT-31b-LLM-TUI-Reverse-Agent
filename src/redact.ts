/**
 * 脱敏防火墙 —— 混合后端「本地执行器 + 云端顾问」的**唯一出网收口**。
 *
 * 设计依据：docs-resources/混合后端-云端顾问-实现方案.md §3。
 * 核心工程杠杆（方案的支点）：**不靠不可靠的 NER 去"猜"敏感**，而是用台账 `Ledger` 已 verbatim
 * 存下的本次任务碰到的所有类名/方法名/路径/grep pattern 作为**确定性敏感清单**，做**精确一致替换**
 * （可逆、高精度），再加正则兜底 catch 清单之外的内嵌敏感（URL/IP/key/绝对路径/包名/资源名）。
 *
 * 三条铁律：
 * 1. **可逆**：同一真值永远映射同一占位符（`toToken`），云端能连贯引用 `<CLS_3>`；`restore` 完美还原。
 * 2. **fail-closed**：脱敏后再跑一遍泄露扫描，命中即塞 `leaks[]`——调用方见非空**默认中止出境**。
 * 3. **不落盘**：`RedactionMap` 只在内存、请求级（落盘=再识别密钥）。
 */

/** 脱敏档：0=只 URL/IP/email/path/key（留混淆类名利思路可落地）；1=+包名/类名/方法名；2=最严（+裸标识符/行号抽象化）。 */
export type RedactLevel = 0 | 1 | 2;

export interface RedactionMap {
  /** 占位符 → 真值（restore 用） */
  toReal: Map<string, string>;
  /** 真值 → 占位符（保证一致替换：同一真值永远同一占位符） */
  toToken: Map<string, string>;
}

export interface RedactResult {
  /** 脱敏后文本（出网的唯一内容） */
  clean: string;
  /** 本地保管，用于 restore */
  map: RedactionMap;
  /** fail-closed 扫描仍疑似泄露的 span（非空 ⇒ 调用方应中止或降级） */
  leaks: string[];
}

/** 台账快照的最小形状（与 memory/ledger.ts 的 LedgerState 结构兼容，避免强耦合导入）。 */
export interface LedgerSnapshot {
  goal: string;
  hops: Array<{ from?: string; to?: string; evidence?: string; raw?: string }>;
  reads: Array<{ path: string }>;
  greps: Array<{ pattern: string; path: string }>;
}

function newMap(): RedactionMap {
  return { toReal: new Map(), toToken: new Map() };
}

/** 正则元字符转义（用于把真值当字面量拼进 RegExp）。 */
function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 真值是否"纯标识符"（只含 \w 和 $）——决定用词边界替换还是字面全局替换。 */
function isBareIdent(s: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(s);
}

/**
 * 一致替换：把 text 里所有 real 替换成稳定占位符。
 * - 纯标识符用**非词字符边界**（含 `$`）避免子串误伤（`C1` 不吃 `C11`）。
 * - 复杂串（含 `.`/`/`/`:` 等，如路径/FQCN）用**字面全局**替换（长优先已在调用处保证）。
 * 返回替换后的 text（map 就地更新）。
 */
function replaceConsistent(
  text: string,
  real: string,
  type: string,
  map: RedactionMap,
  counters: Map<string, number>,
): string {
  if (!real || real.length < 2) return text;
  let token = map.toToken.get(real);
  if (!token) {
    const n = (counters.get(type) ?? 0) + 1;
    counters.set(type, n);
    token = `<${type}_${n}>`;
    map.toToken.set(real, token);
    map.toReal.set(token, real);
  }
  const re = isBareIdent(real)
    ? new RegExp(`(?<![\\w$])${esc(real)}(?![\\w$])`, 'g')
    : new RegExp(esc(real), 'g');
  return text.replace(re, token);
}

/**
 * 按正则找 span、一致替换成占位符（用于兜底：URL/IP/email/path/key/pkg/res）。
 * 每个不同 span 值一致映射（同 URL→同 <URL_n>）。
 */
function replaceByRegex(
  text: string,
  re: RegExp,
  type: string,
  map: RedactionMap,
  counters: Map<string, number>,
): string {
  return text.replace(re, (m) => {
    let token = map.toToken.get(m);
    if (!token) {
      const n = (counters.get(type) ?? 0) + 1;
      counters.set(type, n);
      token = `<${type}_${n}>`;
      map.toToken.set(m, token);
      map.toReal.set(token, m);
    }
    return token;
  });
}

// ——— 兜底检测正则（catch 台账清单之外的内嵌敏感）———
const RE_URL = /\bhttps?:\/\/[^\s'"()<>]+/g;
const RE_EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// 绝对路径（/Users/... 或 /Volumes/...）或含多级 / 的类路径文件（.../a/b/C.java）
const RE_ABSPATH =
  /(?:\/[\w.$-]+){2,}\.(?:java|smali|kt|so|dex|xml|json|txt|md)\b|\/(?:Users|Volumes|home|opt|var|tmp|private)\/[\w./$-]+/g;
// 高熵串（疑似 key/token/base64）：长度≥24、含大小写+数字、无空格
const RE_KEYISH = /\b[A-Za-z0-9_\-+/=]{24,}\b/g;
const RE_IP = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g;
// 安卓资源名
const RE_RES = /(?:@(?:string|drawable|layout|id|color|dimen|style)\/[\w.]+|R\.[a-z]+\.[\w$]+)/g;
// 包名（≥3 段小写点分 + 末段类名）
const RE_PKG = /\b(?:[a-z][a-z0-9_]*\.){2,}[A-Za-z][\w$]*\b/g;

/** Shannon 熵，用于给高熵串兜底降噪（普通英文/十六进制熵较低，随机 key 熵高）。 */
function shannon(s: string): number {
  const freq = new Map<string, number>();
  for (const c of s) freq.set(c, (freq.get(c) ?? 0) + 1);
  let h = 0;
  for (const c of freq.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * 从台账快照汇出「已知敏感标识符清单」（redact 的核心弹药）。
 * 规则（既要全、又要避免把 java/com/get 这类通用词加进去导致过度脱敏毁掉可读性）：
 * - reads.path：整条路径 + 文件名 + 去扩展名类名 +（若 sources/smali 结构）派生 FQCN/包名。
 * - greps.pattern：仅当是「纯标识符/点分名」（无正则元字符）才纳入字面替换清单。
 * - hops.from/to：整条点分名 + 长度≥4/或含数字/或大写开头的段（滤掉 get/set 这类短通用词）。
 * - hops.evidence：文件名 + 去扩展名类名。
 * 返回**长优先**排序（先替长串再替短串，避免子串误伤）。
 */
export function knownIdentifiersFromLedger(state: LedgerSnapshot): string[] {
  const s = new Set<string>();
  const addFileName = (p: string) => {
    const base = p.split('/').pop() ?? p;
    if (/\.(java|smali|kt|so|dex)$/.test(base)) {
      s.add(base);
      const stem = base.replace(/\.(java|smali|kt|so|dex)$/, '');
      if (stem.length >= 2) s.add(stem);
    }
  };
  const addFqcn = (p: string) => {
    // jadx: .../sources/com/foo/Bar.java；smali: .../smali/com/foo/Bar.smali
    const m = p.match(/\/(?:sources|smali[\w-]*)\/(.+)\.(?:java|smali|kt)$/);
    if (m?.[1]) {
      const pkg = m[1].replace(/\//g, '.');
      s.add(pkg); // com.foo.Bar
      const dot = pkg.lastIndexOf('.');
      if (dot > 0) s.add(pkg.slice(0, dot)); // com.foo 包名
    }
  };
  const addDotted = (v?: string) => {
    if (!v) return;
    for (const m of v.matchAll(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g)) {
      const tok = m[0];
      if (tok.includes('.')) s.add(tok); // 整条点分名（如 C7671.methodA）
      for (const part of tok.split('.')) {
        if (part.length >= 4 || /\d/.test(part) || /^[A-Z]/.test(part)) s.add(part); // 滤 get/set 等短通用词
      }
    }
  };
  if (state.goal) addDotted(state.goal); // 目标里可能含包名/类名
  for (const r of state.reads) {
    s.add(r.path);
    addFileName(r.path);
    addFqcn(r.path);
  }
  for (const g of state.greps) {
    // 纯标识符/点分 pattern 才纳入字面清单；且滤掉 get/set/if 这类短通用词（否则过度脱敏毁可读性）
    if (
      /^[\w$.]+$/.test(g.pattern) &&
      (g.pattern.length >= 4 || /\d/.test(g.pattern) || /[A-Z]/.test(g.pattern) || g.pattern.includes('.'))
    )
      s.add(g.pattern);
    if (g.path && g.path !== '.') {
      s.add(g.path);
      addFileName(g.path);
      addFqcn(g.path);
    }
  }
  for (const h of state.hops) {
    addDotted(h.from);
    addDotted(h.to);
    if (h.evidence) {
      const fm = h.evidence.match(/([\w$/.-]+\.(?:java|smali|kt))/);
      if (fm?.[1]) {
        addFileName(fm[1]);
        addFqcn(fm[1]);
      }
    }
  }
  return [...s].filter(Boolean).sort((a, b) => b.length - a.length); // 长优先
}

/**
 * 可逆脱敏。返回 { clean, map, leaks }。
 * 分级：
 * - level 0：只 URL/IP/email/绝对路径/key/资源名（保留裸类名/方法名/包名——混淆名信息量低、利思路可落地）。
 * - level 1：+ 包名 + 台账已知标识符（类名/方法名/FQCN/文件名）。
 * - level 2：+ 裸大写/混淆类标识符（`C18330`/`AbstractFoo`）+ `:行号`→`:<LN>`（只留抽象结构）。
 */
export function redact(text: string, opts: { level: RedactLevel; knownIdentifiers: string[] }): RedactResult {
  const map = newMap();
  const counters = new Map<string, number>();
  let out = text;

  // —— 第 1 层：结构化 PII 正则兜底（所有档都做；顺序：URL/email 先于 IP，path 先于 pkg）——
  out = replaceByRegex(out, RE_URL, 'URL', map, counters);
  out = replaceByRegex(out, RE_EMAIL, 'EMAIL', map, counters);
  out = replaceByRegex(out, RE_ABSPATH, 'PATH', map, counters);
  // 高熵串：先用正则圈候选，再用熵阈值过滤（避免误伤长十六进制/普通长词）
  out = out.replace(RE_KEYISH, (m) => {
    if (shannon(m) < 3.2 || !(/[a-z]/.test(m) && /[A-Z0-9]/.test(m))) return m; // 熵低或非混合 → 不当 key
    let token = map.toToken.get(m);
    if (!token) {
      const n = (counters.get('KEY') ?? 0) + 1;
      counters.set('KEY', n);
      token = `<KEY_${n}>`;
      map.toToken.set(m, token);
      map.toReal.set(token, m);
    }
    return token;
  });
  out = replaceByRegex(out, RE_IP, 'IP', map, counters);

  // —— 第 2 层：台账已知标识符（level ≥ 1）——长优先，先路径/FQCN 后裸名 ——
  if (opts.level >= 1) {
    out = replaceByRegex(out, RE_RES, 'RES', map, counters);
    out = replaceByRegex(out, RE_PKG, 'PKG', map, counters);
    for (const id of opts.knownIdentifiers) {
      // 路径类走 PATH，点分名走 PKG/CLS，其余裸标识符走 SYM
      const type = id.includes('/') ? 'PATH' : id.includes('.') ? 'CLS' : 'SYM';
      out = replaceConsistent(out, id, type, map, counters);
    }
  } else {
    // level 0 也把已知**路径**脱掉（路径暴露目录结构），但保留裸类名/包名
    out = replaceByRegex(out, RE_RES, 'RES', map, counters);
    for (const id of opts.knownIdentifiers) {
      if (id.includes('/')) out = replaceConsistent(out, id, 'PATH', map, counters);
    }
  }

  // —— 第 3 层：level 2 最严——裸大写/混淆类标识符也 token 化 ——
  // 注：不做「行号→<LN>」抽象。行号(`:142`)脱离已脱敏的文件名毫无信息量，却会与占位符相邻
  //     （`<PATH_1>:<LN>`）诱导云端把尖括号合并成 `<PATH_1:<LN>>` → 破坏 restore。得不偿失，去掉。
  if (opts.level >= 2) {
    // 混淆类名 C18330 / 大写驼峰类 AbstractFoo（≥3 字符，避免吃 ID/OK 这类）
    out = replaceByRegex(out, /\b(?:[A-Z][A-Za-z0-9]{2,}|[A-Za-z]\d{3,})\b/g, 'CLS', map, counters);
  }

  // —— fail-closed 泄露扫描：脱敏后 clean 里是否仍残留本档应清掉的敏感 ——
  const leaks = leakScan(out, opts.level);
  return { clean: out, map, leaks };
}

/**
 * fail-closed 泄露扫描：对 clean 再跑一遍**本档承诺清掉**的检测器；命中即视为泄露。
 * 分档：0=URL/email/IP/绝对路径/key（包名/类名允许留）；≥1=+包名/资源名。
 * 注意：占位符 `<URL_1>` 本身不该被误判——检测器都不匹配尖括号 token。
 */
export function leakScan(clean: string, level: RedactLevel): string[] {
  const leaks: string[] = [];
  const push = (re: RegExp) => {
    for (const m of clean.matchAll(re)) leaks.push(m[0]);
  };
  push(RE_URL);
  push(RE_EMAIL);
  push(RE_ABSPATH);
  push(RE_IP);
  for (const m of clean.matchAll(RE_KEYISH)) {
    if (shannon(m[0]) >= 3.2 && /[a-z]/.test(m[0]) && /[A-Z0-9]/.test(m[0])) leaks.push(m[0]);
  }
  if (level >= 1) {
    push(RE_PKG);
    push(RE_RES);
  }
  // 去重
  return [...new Set(leaks)];
}

/**
 * 还原：把云端返回文本里的占位符换回真值。多层容错（云端会各种改写占位符）：
 * A. **尖括号内含我方 inner id → 整括号还原**：覆盖 `<CLS_1>` / `< CLS_1 >` / `&lt;CLS_1&gt;`，
 *    也覆盖云端自造的**复合伪占位符**（实测 minimax 会写 `<PATH_to_CLS_3>` / `<CLS_3 的方法体>`）。
 *    id 前后加**数字边界**防 `CLS_1` 吃掉 `CLS_10`；`[^<>]` 限定不跨括号。
 * B. **裸 inner id 兜底**：`CLS_1`（云端把尖括号整个丢了）——inner id 属我方私有命名空间，
 *    正常文本几乎不会出现 `CLS_1` 这种串，故裸替换安全。
 * 处理顺序：inner id 长的先替（`CLS_10` 先于 `CLS_1`）。
 */
export function restore(text: string, map: RedactionMap): string {
  let out = text;
  const entries = [...map.toReal.entries()].sort((a, b) => b[0].length - a[0].length); // 长 id 先
  for (const [token, real] of entries) {
    const inner = esc(token.slice(1, -1)); // 去尖括号得 CLS_1，转义
    // A: 尖括号(或 HTML 转义)内含 inner id → 整括号还原
    out = out.replace(new RegExp(`(?:<|&lt;)[^<>]*?(?<!\\d)${inner}(?!\\d)[^<>]*?(?:>|&gt;)`, 'g'), real);
    // B: 无括号的裸 id 兜底（词边界）
    out = out.replace(new RegExp(`(?<![\\w])${inner}(?![\\w])`, 'g'), real);
  }
  return out;
}
