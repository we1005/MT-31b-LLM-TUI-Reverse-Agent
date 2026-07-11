/**
 * P1「主动栈探测前置」。
 *
 * 动机（见 docs-resources/安全审计-篡改APK破解审计.md 第 3 轮 + 能力边界 README）：
 * Round-3 最危险的失败模式 = 栈识别 **false-negative**：agent 不做 `unzip -l` 看 lib/，
 * 就自信断言目标"无 native / 无 Unity / 纯 Java"（Duolingo 谎称无 libil2cpp 实则 29MB 在；
 * 酷我谎称纯 Java 实则 Hippy/DexVMP 俱在）。根因有二：
 *   (a) 模型自己 gather 栈信息会失败；
 *   (b) workdir 往往指向 jadx 的 `sources/`（只有 java 包），物理上看不到 lib/assets，
 *       .so / global-metadata.dat 只在**原始 APK** 里。
 *
 * 解药：开局**确定性**地替模型探栈——定位原始 APK → `unzip -l` 看 lib/assets 签名 →
 * 把权威"栈报告"注入首条消息。找不到 APK（只有 sources/）就**如实说"看不到 lib/，无法判栈，
 * 切勿断言无 X"**。两条都从源头掐掉 false-negative。
 *
 * 合规：只读 `unzip -l`（列目录，不解包不改），纯防御性侦察。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { isSourceLevelTask } from './preflight.ts';

export interface StackSignature {
  /** 栈名 */
  stack: string;
  /** 逻辑载体 + jadx 是否看得到 */
  where: string;
  /** 推荐工具 */
  tool: string;
}

export interface StackReport {
  apkPath?: string;
  /** 命中的非 native-dex 栈成分（Unity/Flutter/RN/Hippy/WebApp/加固…） */
  hits: StackSignature[];
  /** 是否含任意 native .so */
  hasNativeSo: boolean;
  dexCount: number;
  /** 只有 sources/、定位不到 APK 时为 true —— 报告转为"无法判栈"诚实模式 */
  dataGap: boolean;
  /** 注入给模型的完整文本 */
  verdict: string;
}

/**
 * 探栈触发意图：比 isSourceLevelTask 更宽——栈识别/native/加固/审计类任务都该探栈。
 * 探栈本身廉价无害（只加一段上下文），宁可多触发也别漏掉栈识别题（P1 的核心服务对象）。
 */
const STACK_INTENT = [
  /技术栈|技术站|栈边界|什么栈|哪个栈|stack\b/i,
  /native|\.so\b|so\s*库|jni/i,
  /加固|脱壳|壳(?!牌)|packer|vmp|dexvmp/i,
  /unity|il2cpp|flutter|react\s*native|hermes|hippy|weex|cordova|capacitor|web\s?app/i,
  /破解|篡改|crack|\bmod\b|vip|会员|premium|解锁|盗版/i,
  /\bdex\b|\.apk\b|反编|逆向/i,
];

/** 本任务是否需要探栈：源码级 或 栈/native/加固/审计意图。 */
export function shouldProbe(task: string): boolean {
  return isSourceLevelTask(task) || STACK_INTENT.some((re) => re.test(task));
}

/** 栈指纹：在 `unzip -l` 全文里做大小写不敏感子串/正则匹配。顺序=优先展示顺序。 */
const SIGNATURES: Array<{ re: RegExp; sig: StackSignature }> = [
  {
    re: /libil2cpp\.so|global-metadata\.dat|libunity\.so|assets\/bin\/Data|assets\/aa\//i,
    sig: { stack: 'Unity (IL2CPP)', where: '逻辑在 libil2cpp.so + global-metadata.dat；jadx 只看得到 dex 壳，看不到 IL2CPP 方法体', tool: 'Il2CppDumper / Il2CppInspector' },
  },
  {
    re: /libflutter\.so|libapp\.so|flutter_assets\//i,
    sig: { stack: 'Flutter', where: '逻辑在 libapp.so 的 Dart AOT snapshot；jadx 几乎看不到', tool: 'blutter / reFlutter' },
  },
  {
    re: /libhermes\.so/i,
    sig: { stack: 'React Native (Hermes)', where: '逻辑在 index.android.bundle 的 Hermes 字节码；jadx 看不到', tool: 'hermes-dec' },
  },
  {
    re: /assets\/jsbundle\/hippy|libhippy/i,
    sig: { stack: '腾讯 Hippy (跨端 JS)', where: '逻辑在 assets/jsbundle/hippy* 的 webpack JS（常明文）；jadx 看不到', tool: '直接读 jsbundle JS + beautifier' },
  },
  {
    re: /libweexcore|libweexjss/i,
    sig: { stack: '阿里 Weex (跨端 JS)', where: '逻辑在 Weex JS bundle；jadx 看不到', tool: '直接读 JS bundle' },
  },
  {
    re: /index\.android\.bundle/i,
    sig: { stack: 'React Native (JS bundle)', where: '逻辑在 assets/index.android.bundle（JS，可能 Hermes 字节码）', tool: '读 bundle / hermes-dec' },
  },
  {
    re: /assets\/www\/|cordova|capacitor/i,
    sig: { stack: 'WebApp (Cordova/Capacitor)', where: '逻辑在 assets/www/*.js（多为明文/压缩 JS）', tool: '直接读 assets/www JS' },
  },
  {
    re: /libjiagu/i,
    sig: { stack: '360 加固', where: 'dex 运行时解密，静态只见壳加载器', tool: '动态脱壳 (frida-DEXDump)' },
  },
  {
    re: /libshell|libDexHelper|libprotectClass|libSecShell/i,
    sig: { stack: '梆梆/爱加密 加固', where: 'dex 运行时解密，静态只见壳', tool: '动态脱壳' },
  },
  {
    re: /libsgmain|libsgsecuritybody|libnesec|libmobisec/i,
    sig: { stack: '阿里聚安全 加固', where: 'dex 保护 + native 校验', tool: '动态脱壳 + IDA' },
  },
  {
    re: /libtmeshield|libtmesec|libFireEye|libdexvmp/i,
    sig: { stack: '腾讯加固 / DEX-VMP', where: 'DEX 虚拟化 + native 保护；静态 jadx 可能只见平坦化/花指令', tool: '动态脱壳 + 反 VMP' },
  },
];

/** 从 workdir 路径里推 `*-jadx` / `*-apkt` 的 stem（用于匹配同名 APK）。 */
function deriveStem(workdir: string | undefined): string | undefined {
  if (!workdir) return undefined;
  let cur = workdir;
  for (let i = 0; i < 6 && cur && cur !== '/'; i++) {
    const b = basename(cur);
    const m = b.match(/^(.+?)-(jadx|apkt|apktool|out)$/i);
    if (m) return m[1].toLowerCase();
    cur = dirname(cur);
  }
  return undefined;
}

/** 在若干候选目录里（非递归 + corpus 浅递归）收集 *.apk。 */
function collectApks(dirs: string[]): string[] {
  const out = new Set<string>();
  for (const d of dirs) {
    if (!d || !existsSync(d)) continue;
    try {
      if (!statSync(d).isDirectory()) {
        if (/\.apk$/i.test(d)) out.add(d);
        continue;
      }
      for (const name of readdirSync(d)) {
        if (/\.apk$/i.test(name)) out.add(join(d, name));
      }
    } catch {
      // skip
    }
  }
  return [...out];
}

/** 定位原始 APK：从 workdir 向上找兄弟/父层的 *.apk，按 stem 匹配；corpus 根也扫。 */
export function locateApk(workdir: string | undefined, corpus: string | undefined, task: string): string | undefined {
  // 任务文本里直接写了 .apk 路径 → 最优先
  const inTask = task.match(/(\/[^\s"'`）)，。、]+\.apk)/i);
  if (inTask && existsSync(inTask[1])) return inTask[1];

  const cand: string[] = [];
  if (corpus) cand.push(corpus);
  if (workdir) {
    let cur = workdir;
    for (let i = 0; i < 4 && cur && cur !== '/'; i++) {
      cand.push(cur);
      cur = dirname(cur);
    }
  }
  const apks = collectApks(cand);
  if (apks.length === 0) return undefined;
  if (apks.length === 1) return apks[0];

  // 多个 → 按 stem 匹配（duolingo-jadx ↔ Duolingo-Premium-*.apk）
  const stem = deriveStem(workdir);
  if (stem) {
    const matched = apks.find((a) => basename(a).toLowerCase().includes(stem));
    if (matched) return matched;
  }
  // 仍不确定：返回第一个但调用方会在报告里标"候选多个"（此处从简，返回 undefined 触发 dataGap 更安全）
  return undefined;
}

/** 跑 `unzip -l`（只读列目录），失败返回 null。 */
function unzipList(apk: string): string | null {
  try {
    return execFileSync('unzip', ['-l', apk], {
      encoding: 'utf-8',
      timeout: 15_000,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/**
 * 主入口：探栈并产出报告。仅对源码级/审计/corpus 任务生效（纯"读方法 X"类不打扰）。
 * 返回 undefined = 本任务不需要探栈。
 */
export function probeStack(opts: { workdir?: string; corpus?: string; task: string }): StackReport | undefined {
  if (!opts.corpus && !shouldProbe(opts.task)) return undefined;

  const apk = locateApk(opts.workdir, opts.corpus, opts.task);
  if (!apk) {
    // 定位不到 APK：多半只有 jadx sources/，看不到 lib/assets → 诚实"无法判栈"，严禁 agent 断言无 X
    return {
      hits: [],
      hasNativeSo: false,
      dexCount: 0,
      dataGap: true,
      verdict:
        '【栈探测（自动 preflight）】未定位到原始 APK。你当前多半只有 jadx 反编译的 `sources/`（纯 Java 包），' +
        '**物理上看不到 `lib/*.so` 与 `assets/`**——因此**无法判定本目标是否含 native / Unity / Flutter / 加固**。\n' +
        '⚠️ 铁律：**切勿据"我没看到 .so"就断言"无 native / 纯 Java / 无加固"**（Round-3 的头号错误）。若需判栈，向用户要原始 APK 或 `unzip -l` 输出。',
    };
  }

  const txt = unzipList(apk);
  if (!txt) {
    return {
      apkPath: apk,
      hits: [],
      hasNativeSo: false,
      dexCount: 0,
      dataGap: true,
      verdict:
        `【栈探测（自动 preflight）】定位到 APK ${basename(apk)} 但 unzip 读取失败。**切勿断言"无 native / 纯 Java"**——请自行 \`unzip -l ${apk}\` 复核后再判栈。`,
    };
  }

  const hits: StackSignature[] = [];
  for (const { re, sig } of SIGNATURES) {
    if (re.test(txt) && !hits.some((h) => h.stack === sig.stack)) hits.push(sig);
  }
  const soMatches = txt.match(/lib\/[^/\n]+\/lib[^\s/]+\.so/gi) ?? [];
  const soNames = [...new Set(soMatches.map((s) => s.replace(/lib\/[^/]+\//i, '')))];
  const hasNativeSo = soNames.length > 0;
  const dexCount = (txt.match(/classes[0-9]*\.dex/gi) ?? []).length;

  // 拼报告
  const lines: string[] = [`【栈探测（自动 preflight，权威——已 unzip -l 原始 APK ${basename(apk)}）】`];
  lines.push(`· classes*.dex = ${dexCount} 个${dexCount > 0 ? '（会员/业务门禁通常在 dex，除非下方栈另有承载）' : ''}`);
  lines.push(`· native .so = ${hasNativeSo ? `${soNames.length} 个（${soNames.slice(0, 8).join(', ')}${soNames.length > 8 ? ' …' : ''}）` : '未见'}`);
  if (hits.length > 0) {
    lines.push(`· ⚠️ 检测到以下**非 dex / 跨端栈成分（jadx 的 sources/ 里看不到，但它们确实存在于 APK）**：`);
    for (const h of hits) lines.push(`    - ${h.stack}：${h.where}；工具→ ${h.tool}`);
    lines.push(
      `· 判据与边界：dex 里 grep 不到某逻辑**不等于**它不存在——上面这些成分承载的逻辑本就不在 jadx sources/。` +
        `下结论"逻辑在 dex 侧 vs 在 X 侧"时，必须结合本报告，**严禁断言"无 native / 无 Unity / 纯 Java"**（Round-3 头号错误）。`,
    );
  } else {
    lines.push(
      `· 未命中 Unity/Flutter/RN/Hippy/WebApp/加固 指纹${hasNativeSo ? '（但有 native .so，业务若涉解密/鉴权可能落在 native，jadx 看不到）' : ''}。` +
        `大概率业务逻辑在 dex（native Java/Kotlin）。但这是基于 APK 清单的判断，具体仍以你 read 到的代码为准。`,
    );
  }

  return {
    apkPath: apk,
    hits,
    hasNativeSo,
    dexCount,
    dataGap: false,
    verdict: lines.join('\n'),
  };
}
