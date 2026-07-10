/**
 * P0 前置校验：源码级逆向任务必须有「完整 Java 源码树」才进 agent loop。
 *
 * 动机（见「三提议深度分析」§2）：
 * - 整包 jadx 反编译 31MB APK ~123s > shell 60s 硬超时（完整性审查 D1），agent 物理上跑不完；
 * - 且这一步 LLM 零增值、是已观测失败源（recon-3 fumble aapt2 语法）；
 * - 全部 benchmark 11/12 分数本来就建立在「源码已预反编译」前提上。
 *
 * 所以：源码级任务缺源码树时，秒级 fail-fast + 给一行可抄配方，而不是让 agent 撞 123s 超时墙。
 * 照搬 resume.ts 的「不静默退化」模式。
 *
 * 边界（不扩大）：只锁「完整源码树」。§3.A 指纹/manifest 类秒级工具（apkid/aapt2/apktool d --no-src）
 * 不受影响——它们既不超时又真有用，继续留在 loop 内自动跑。
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 源码级意图关键词：命中才要求完整源码树；纯侦察/摘要类不触发（避免误伤 §3.A 全自动场景）。 */
const SOURCE_LEVEL_INTENT = [
  /源码|源代码/,
  /调用链|调用关系|call\s*flow|callflow|caller|callee/i,
  /追踪|trace(?!\b.*apk\b)/i,
  /找类|定位类|哪个类|入口类|实现类|which\s+class/i,
  // "路由类/服务类/校验类/主类…" 这种「名词+类」（排除"类型"）——源码级定位的高频表达
  /[一-龥A-Za-z]{1,6}类(?!型)/,
  /反编译(?!.*apk\s*$)/, // "反编译看源码" 触发；纯 "反编译这个apk" 由下面的 workdir 判断兜底
  /方法体|函数体|method\s+body/i,
  /smali|字节码|bytecode/i,
  /读\s*.*\.java|看\s*.*\.java/,
];

/** 判断任务是否是「源码级」——需要现成的 Java/smali 源码树。 */
export function isSourceLevelTask(task: string): boolean {
  return SOURCE_LEVEL_INTENT.some((re) => re.test(task));
}

/** 判断目录是否「已反编译的完整源码树」：含 sources 或 smali 目录，或直接是一堆 .java/.smali。 */
export function looksLikeSourceTree(dir: string): boolean {
  if (!dir || !existsSync(dir)) return false;
  try {
    if (!statSync(dir).isDirectory()) return false;
  } catch {
    return false;
  }
  // 常见形态：jadx 输出的 sources/、apktool 输出的 smali/ smali_classes2/、或目录本身就是 sources
  const markers = ['sources', 'smali', 'smali_classes2'];
  for (const m of markers) {
    if (existsSync(join(dir, m))) return true;
  }
  // 目录本身直接含 .java / .smali / .dex（用户把 --workdir 指到 sources 内部时）
  try {
    const entries = readdirSync(dir);
    if (entries.some((e) => /\.(java|smali|dex)$/.test(e))) return true;
    // 或含单字母混淆包目录（jadx sources 常见 l/ o/ p/ 之类）里有 .java
    for (const e of entries.slice(0, 40)) {
      const sub = join(dir, e);
      try {
        if (statSync(sub).isDirectory() && readdirSync(sub).some((f) => /\.(java|smali)$/.test(f))) return true;
      } catch {
        // skip
      }
    }
  } catch {
    // skip
  }
  return false;
}

export interface PreflightResult {
  ok: boolean;
  /** ok=false 时给用户的可抄配方 + 说明 */
  message?: string;
}

/** 从任务文本里抽出「绝对路径」候选（用户常把源码目录直接写进任务，如"在 /a/b/sources 里找…"）。 */
function extractAbsolutePaths(task: string): string[] {
  // 匹配以 / 开头的路径 token（到空格/引号/中文标点/行尾为止）
  const matches = task.match(/(?:^|[\s"'`（(])(\/[^\s"'`）)，。、]+)/g) ?? [];
  return matches.map((m) => m.replace(/^[\s"'`（(]/, '')).filter(Boolean);
}

/**
 * 前置校验。返回 ok=false 时调用方应打印 message + 退出码 2，不进 loop。
 * 只在「源码级任务 且 找不到任何现成源码树」时拦；其余一律放行。
 * 源码树来源有二：--workdir，或**任务文本里写的绝对路径**（用户原提议本意=拿到路径就开工）。
 */
export function preflightSourceTree(task: string, workdir: string | undefined): PreflightResult {
  // 非源码级任务（侦察/摘要/裸 APK 指纹等）：不拦，放行
  if (!isSourceLevelTask(task)) return { ok: true };
  // 源码级任务，但已给了源码树（--workdir 或任务文本里的绝对路径任一命中）：放行
  if (workdir && looksLikeSourceTree(workdir)) return { ok: true };
  if (extractAbsolutePaths(task).some((p) => looksLikeSourceTree(p))) return { ok: true };

  // 源码级任务却没有源码树 → fail-fast + 配方
  const wd = workdir ? `当前 --workdir=${workdir}` : '未指定 --workdir';
  return {
    ok: false,
    message:
      `这是一个「源码级」逆向任务（需要现成的 Java/smali 源码），但${wd} 里没找到反编译源码树` +
      `（sources/ 或 smali/ 或 .java/.smali/.dex）。\n` +
      `\n原因：整包 jadx 反编译一个几十 MB 的 APK 要 ~2 分钟，会撞 agent 的 shell 60s 超时，` +
      `而且这一步没有分析价值。请你先在终端手动跑一次反编译，再把输出目录用 --workdir 指给我：\n` +
      `\n  # 反编 Java 源码（推荐，看逻辑）\n` +
      `  jadx --no-res -d out-jadx <你的.apk>\n` +
      `\n  # 或 只解 smali + 资源（更快，改 smali 用）\n` +
      `  apktool d -f -o out-apkt <你的.apk>\n` +
      `\n然后重新调用（源码在 out-jadx/sources 或 out-apkt）：\n` +
      `  rev-agent --once "<你的逆向问题>" --workdir <out-jadx 或其 sources 子目录>\n` +
      `\n（若你只是想看包名/权限/加固等「指纹」信息，不需要反编译——把任务描述成"看 XX.apk 的包名/加固/exported 组件"，我会直接用 aapt2/apkid 秒级搞定。）`,
  };
}
