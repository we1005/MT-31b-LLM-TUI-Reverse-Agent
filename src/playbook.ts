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
      'grep 授权判定入口（名字随 App 变，多试几组别只试 vip）：' +
        'isVip|isPro|isPremium|checkVip|isPurchased|hasPremium|getHasBuyed|entitlement|license 以及 ' +
        'isSubscribed|isSubscription|hasSubscription|isPlusSubscription|isGoldSubscription|isPlus|isSuper|subscription|premium|donate|adFree|isAdFree|skuPremium',
      '对每个命中的判定方法/getter，read 其方法体（≤200 行）看真实现——常见 mod 四套路：',
      '  ① 恒真返回：方法体读了 prefs.getBoolean(...) 却丢弃返回值、随后无条件 return true（弃读孤儿 = smali const-patch 指纹）',
      '  ② 三元恒真/重言式：return cond ? true : true（两分支都 true）或 return !true(=false)——被 patch 成与条件无关的恒定值（Duolingo isPlusSubscription / Code Editor 实见）',
      '  ③ 校验删除/短路：签名/License/Play Billing 校验被删或 if 反转跳过；或 mod 注入恒真 helper 类（如 com.<modder>.common.leetrue() 恒 return true）供各门禁调用（Clone 实见）',
      '  ④ 真 patch 常在深一两跳：入口方法逻辑完整时，真改动在它调用的 getter（getHasBuyed/getHasSubscribe）或它读的 StateFlow 被 new kr1(true) 硬播种 → 跟进去 read，别停在入口',
      '也可直接 grep 篡改指纹定位：字面 `? true : true`、`return true;` 扎堆的类、getBoolean(...) 后无赋值的孤儿行',
      '定位到后给四段式：破解点（类.方法+行号）/ 手法 / 调用链 / 加固（服务端校验 + 完整性签名校验 + 多点冗余 + 反 tamper）',
    ],
    source: 'seed',
    provenance: '本项目 EasyNotes(getHasBuyed 深两跳)/Device_Info(op4 new kr1(true))/Duolingo(isPlusSubscription ?true:true)/Clone(注入 leetrue 恒真 helper) 审计归纳',
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
  {
    id: 'mod-sig-bypass',
    triggerPatterns: [/破解|篡改|crack|\bmod\b|重签|重打包|签名|盗版|授权/i],
    title: '签名校验绕过识别（审计视角：认出 App 本有自校验但被中和）',
    steps: [
      '原签名被破坏、换模组作者自签证书补 v2/v3 是重打包普遍现象——先 apksigner verify --print-certs 看证书 DN/别名（DN 常暴露作者：CN=lushu=鹿蜀 / CN=zhou=zhou45 / CN=editor=NURIK / CN=笙=黯笙 / 伪 O=Google=youarefinished）',
      'App 若本有签名自校验，mod 常注入"签名过验证"模块中和它——审计指纹：字符串/类 ApkSignatureKillerEx、bin.mt.signature.KillerApplication、com.srpatchv3、libyrf.so/libSignatureKiller*.so；Application 继承链(.super)被改指向 KillerApplication',
      '机制：反射伪造 PackageManager 返回的签名（改 PackageInfo.CREATOR / 清空 sPackageInfoCache）让自校验读到"原厂证书"——故"有签名校验≠校验有效"',
      '认出它=该 App 原本就做了签名自校验（记入加固分析）。加固方向：别只靠 PackageManager.getPackageInfo(GET_SIGNATURES)，改 native 直接解析 v2/v3 签名块、且校验结果参与业务解密（非仅 if 分支）',
    ],
    source: 'seed',
    provenance: 'apk-2 99 样本:懒人驾考/扫描王/喜马拉雅/千古诵诗词/无痛单词 等 27 例签名绕过归纳',
  },
  {
    id: 'mod-native-hidden',
    triggerNativeSo: true,
    triggerPatterns: [/破解|篡改|crack|\bmod\b|会员|vip|premium|去广告|解锁/i],
    title: '改动被"方法原生化"隐藏时的止损（grep 不到明文判定就要想到）',
    steps: [
      '若按套路 grep 判定/广告方法却"干净得反常"（方法体正常、找不到恒真化），改动很可能被 Dex2C 编译进了 native——不是"没有破解"',
      '原生化指纹：smali 方法标 native + 对应 .so；lib 下 libstub.so（NP管理器 Apk-Dex2C）、.source "YJ-Dex2C"/云镜(yjaq.xyz)、libcxapkmod.so（Cxapk）、libDexHelper.so；assets 里加密 dex 分片（.Epic / 非标准 dex 头）',
      '⚠️ 静态到此为界：native 内具体逻辑纯 jadx/smali 读不出——**如实标注"改动已原生化、静态不可还原"，别据"smali 没搜到"就断言"无破解"**（本类任务最常见误判）',
      '要继续需动态（frida hook 该 native 方法 / 脱壳 dump）；超出纯静态能力时明确把边界交回，不要幻觉补全',
    ],
    source: 'seed',
    provenance: 'apk-2 99 样本:七猫/快对AI/墨迹天气/拷贝漫画 等 Dex2C 原生化归纳',
  },
  {
    id: 'mod-inject-module',
    triggerPatterns: [/内置|模块|注入|xposed|lsp(atch|osed)?|hook|漫游|猪手/i],
    title: '免 Root 注入模块识别（去广告/功能增强常靠运行时 Hook，非静态改）',
    steps: [
      '"内置X模块/去广告/纯净"常不是静态改字节码，而是整包灌入免 Root 注入框架 + ART Hook 引擎，运行时 Hook 目标方法',
      '引导指纹：AndroidManifest 的 appComponentFactory 被改成非常规类；多出 *InitProvider（ContentProvider，initOrder 高、最早启动）；LSPatch 元数据（assets/lspatch、LSPAppComponentFactoryStub）',
      'Hook 引擎指纹：lib 下 liblshook/libpine/liblsplant/libEpic/libaliuhook；org.lsposed/hiddenapibypass；成堆 XC_MethodHook 桩类',
      '反证信号：原广告 SDK 组件/素材仍原样保留却"没广告"=运行时拦截而非物理删除；具体 Hook 目标常被混淆/原生化，静态只能定位"注入了什么框架、从哪引导"，Hook 了哪个方法多半需动态确认——诚实标注',
    ],
    source: 'seed',
    provenance: 'apk-2 99 样本:微博猪手/B站漫游(Kunkka)/囧次元/搜磁器/拷贝漫画 等注入模块归纳',
  },
  {
    id: 'mod-adfree',
    triggerPatterns: [/去广告|免广告|无广告|adfree|ad-?free|净化|纯净/i],
    title: '去广告 mod 的两条路（定位方向）',
    steps: [
      '路 A 静态摘除：广告 SDK 入口被 no-op/删组件/改开关资源——grep 广告 SDK 包名（admob/gms.ads、穿山甲 pangle/bytedance、优量汇 GDT/qq、gromore/topon/mintegral）、开屏 SplashAd/插屏 Interstitial 空实现、广告开关字段被改',
      '路 B 运行时 Hook：见"注入模块"套路——广告组件仍在但被 Hook 空跑；此路静态改动少，别只盯删代码',
      '先判走哪条：manifest 里广告组件在不在、有没有注入框架指纹；两条路排查锚点不同',
    ],
    source: 'seed',
    provenance: 'apk-2 99 样本:37 例去广告归纳',
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
