/**
 * 程序性 playbook（框架化 MVP-3/4）—— 按**硬可观测栈信号**主动注入"做法/套路"，只作 context 不作 control。
 *
 * 设计铁律（docs-resources/框架化-把逆向负担从模型移到框架.md）：
 * - **程序性知识**（how-to 套路），不是事实 RAG。
 * - **由系统按硬信号主动注入**（stack-probe 确凿命中 / 任务关键词），不靠弱模型自己想到去检索
 *   （解"弱模型不会主动查知识库"悖论）。
 * - **只作 context**：注入为"参考做法·可无视"，模型可不理；绝不"检测到 X 就强制执行 Y 步"。
 * - **优先自动生长**（MVP-4：从解出的 ledger 轨迹归纳），手写 seed 仅冷启动兜底。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { LedgerState } from './memory/ledger.ts';
import type { StackReport } from './stack-probe.ts';

export interface Playbook {
  id: string;
  /** 触发：栈名子串（匹配 StackReport.hits[].stack）之一 */
  triggerStacks?: string[];
  /** 触发：任务文本关键词正则之一 */
  triggerPatterns?: RegExp[];
  /** 触发：任意 native .so 存在 */
  triggerNativeSo?: boolean;
  title: string;
  steps: string[];
  source: 'seed' | 'learned';
  provenance?: string;
}

/** 冷启动 seed playbook（手写最小集；真正增量靠 MVP-4 自动生长）。 */
const SEED: Playbook[] = [
  {
    id: 'crack-audit',
    triggerPatterns: [/破解|篡改|crack|\bmod\b|vip|会员|premium|解锁|盗版|授权|付费/i],
    title: '破解审计套路（付费/会员绕过定位）',
    steps: [
      'grep 授权判定入口：isVip|isPro|isPremium|checkVip|isPurchased|isSubscribed|hasPremium|getHasBuyed|getHasSubscribe|entitlement|license',
      '对每个命中的判定方法/getter，read 其方法体（≤200 行）看真实现——常见 mod 三套路：',
      '  ① 恒真返回：方法体读了 prefs.getBoolean(...) 却丢弃返回值、随后无条件 return true（弃读孤儿 = smali const-patch 指纹）',
      '  ② 校验删除/短路：签名校验 / LicenseChecker / Play Billing 校验被删，或 if 判断被反转/跳过',
      '  ③ 真 patch 常在深一两跳：isVip() 本身逻辑完整时，真改动在它调用的 getHasBuyed()/getHasSubscribe() 这类 getter → 必须跟进去 read，别停在 isVip',
      '定位到后给四段式：破解点（类.方法+行号）/ 手法 / 调用链 / 加固（服务端校验 + 完整性签名校验 + 多点冗余 + 反 tamper）',
    ],
    source: 'seed',
    provenance: '本项目 EasyNotes(getHasBuyed 深两跳恒真)/Device_Info(op4 构造器 new kr1(true)) 审计归纳',
  },
  {
    id: 'unity-il2cpp',
    triggerStacks: ['Unity'],
    title: 'Unity IL2CPP 逆向套路',
    steps: [
      'jadx 的 sources/ 只有 dex 壳，真逻辑在 libil2cpp.so + global-metadata.dat——别在 dex 里找业务方法体',
      '从原始 APK 提 libil2cpp.so 与 global-metadata.dat → 跑 Il2CppDumper/Il2CppInspector 得 dump.cs（含类/方法名+偏移）',
      '在 dump.cs grep 目标方法名 → 拿方法 RVA/偏移 → 在 IDA/Ghidra 打开 so 定位到该偏移读汇编',
      '静态到边界后，运行时确认用 frida hook 该方法',
    ],
    source: 'seed',
  },
  {
    id: 'flutter',
    triggerStacks: ['Flutter'],
    title: 'Flutter 逆向套路',
    steps: [
      '逻辑在 libapp.so 的 Dart AOT snapshot，jadx 几乎看不到——Java 层通常只是插件桥',
      '用 blutter（AOT snapshot 反汇编）或 reFlutter（重打包插桩）拿 Dart 类/方法',
      '网络类逻辑常可绕过 Dart：直接抓包（Flutter 默认不走系统代理，用 reFlutter/frida 禁 SSL pinning 后抓）',
    ],
    source: 'seed',
  },
  {
    id: 'rn-hermes',
    triggerStacks: ['React Native', 'Hippy', 'Weex', 'WebApp'],
    title: '跨端 JS（RN/Hippy/Weex/WebApp）逆向套路',
    steps: [
      '逻辑在 JS bundle（assets/index.android.bundle / jsbundle / assets/www），jadx 看不到',
      'Hermes 字节码 → hermes-dec 反编；明文/webpack JS → 直接读 + beautifier；WebApp → 读 assets/www/*.js',
      'grep bundle 里的关键字（vip/premium/token/接口路径）定位业务；别在 dex 里找',
    ],
    source: 'seed',
  },
  {
    id: 'packer',
    triggerStacks: ['加固', 'DEX-VMP', '聚安全'],
    title: '加固/脱壳套路',
    steps: [
      'dex 是壳，真 dex 运行时才解密/释放——静态 jadx 只见壳加载器，grep 不到真业务是正常的',
      '先脱壳：frida-DEXDump / FRIDA-based unpacker 运行时 dump 真 dex，再对 dump 出的 dex 做 jadx',
      'DEX-VMP（腾讯/字节）：可能还需反 VMP，静态会见平坦化/花指令；承认静态上限，转动态',
      '⚠️ 别据"静态没找到"就断言"无此逻辑"——它在脱壳后的 dex 里',
    ],
    source: 'seed',
  },
];

const LEARNED_PATH = join(process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config'), 'rev-agent', 'learned-playbooks.json');

/** 载入自动生长的 learned playbook（MVP-4）。文件不存在/坏 → 空。 */
export function loadLearned(path = LEARNED_PATH): Playbook[] {
  try {
    if (!existsSync(path)) return [];
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Array<Omit<Playbook, 'triggerPatterns'> & { triggerPatternsSrc?: string[] }>;
    return raw.map((p) => ({ ...p, triggerPatterns: (p.triggerPatternsSrc ?? []).map((s) => new RegExp(s, 'i')), source: 'learned' as const }));
  } catch {
    return [];
  }
}

/** 持久化 learned playbook（RegExp 转字符串存）。 */
export function saveLearned(pbs: Playbook[], path = LEARNED_PATH): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const ser = pbs.map((p) => ({ ...p, triggerPatterns: undefined, triggerPatternsSrc: (p.triggerPatterns ?? []).map((r) => r.source) }));
    writeFileSync(path, JSON.stringify(ser, null, 2));
  } catch {
    /* 落盘失败不影响主流程 */
  }
}

/** 选出该任务/栈应注入的 playbook（seed + learned；栈命中或任务关键词命中或 native）。 */
export function matchPlaybooks(stack: StackReport | undefined, task: string, learned: Playbook[] = loadLearned()): Playbook[] {
  const all = [...SEED, ...learned];
  const stackNames = stack && !stack.dataGap ? stack.hits.map((h) => h.stack) : [];
  const out: Playbook[] = [];
  for (const pb of all) {
    const byStack = pb.triggerStacks?.some((s) => stackNames.some((n) => n.includes(s)));
    const byPat = pb.triggerPatterns?.some((re) => re.test(task));
    const byNative = pb.triggerNativeSo && stack && !stack.dataGap && stack.hasNativeSo;
    if (byStack || byPat || byNative) out.push(pb);
  }
  return out;
}

/** 渲染注入块——**明确标注"参考做法·可无视"，只作 context**（框架铁律）。 */
export function renderPlaybookBlock(pbs: Playbook[]): string {
  if (pbs.length === 0) return '';
  const parts = ['【参考做法（套路提示·可无视，不是命令；你自己判断是否适用于本目标）】'];
  for (const pb of pbs) {
    parts.push(`▶ ${pb.title}${pb.source === 'learned' ? '（从过往解出案例自动归纳）' : ''}：`);
    for (const s of pb.steps) parts.push(`  ${s}`);
  }
  return parts.join('\n');
}

/**
 * MVP-4：从一次**解出**的 ledger 轨迹自动归纳一条 learned playbook（栈相关的 grep→read 顺序）。
 * 只在真解出（有 corroborated hop 或足量 reads）且能绑定到某栈信号时才产，避免噪声。返回 null=不学。
 */
export function learnPlaybookFromLedger(ledger: LedgerState, stack: StackReport | undefined): Playbook | null {
  const solved = ledger.hops.some((h) => h.corroborated) || ledger.reads.length >= 3;
  if (!solved) return null;
  const stackName = stack && !stack.dataGap && stack.hits[0] ? stack.hits[0].stack : undefined;
  const patterns = [...new Set(ledger.greps.map((g) => g.pattern))].filter((p) => /^[\w$.|]+$/.test(p)).slice(0, 6);
  if (!stackName && patterns.length === 0) return null;
  const winReads = ledger.reads.slice(0, 5).map((r) => r.path.split('/').pop() ?? r.path);
  return {
    id: `learned-${stackName ? stackName.replace(/\s+/g, '') : 'generic'}-${Date.now().toString(36)}`,
    triggerStacks: stackName ? [stackName.split(/[ (]/)[0]!] : undefined,
    triggerPatterns: patterns.length ? [new RegExp(patterns.slice(0, 3).join('|'), 'i')] : undefined,
    title: `${stackName ?? '此类目标'}上一次解出的路径`,
    steps: [
      patterns.length ? `曾用 grep 锚点：${patterns.join(' / ')}` : '（无显著 grep 锚点）',
      winReads.length ? `曾精读关键类：${winReads.join(' , ')}` : '',
      ledger.hops.length ? `曾连出 ${ledger.hops.length} 跳（${ledger.hops.filter((h) => h.corroborated).length} 交叉核验）` : '',
    ].filter(Boolean),
    source: 'learned',
    provenance: `ledger 自动归纳 @ goal="${(ledger.goal || '').slice(0, 40)}"`,
  };
}
