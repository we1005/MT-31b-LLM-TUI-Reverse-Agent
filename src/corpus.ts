/**
 * P0「案卷续分析模式」（--corpus）。
 *
 * 场景（见 docs-resources/多Agent协作-强模型前置产物的续分析改进设计.md）：
 * 用户先用更强的 agent（Claude Code/Codex）+ Frida/抓包/dump 对 APK 做前置分析，
 * 产出一整个「案卷目录」——一堆 MD 结论 + 动态 trace + pcap/har + native dump + 中间产物。
 * 然后让本地小 agent 接手这个目录续分析（核验/补链/交叉印证/扩展），而不是从裸 APK 从零逆向。
 *
 * 现状 preflight 把输入写死成「一棵源码树」，不适配案卷目录。本模块提供：
 *  - scanCorpus：秒级扫案卷根，产出带类型分类的 manifest（源码树只记一条、不递归进去）；
 *  - buildManifestText：把 manifest 降成紧凑文本，注入让 agent 开局就知道有什么、先读什么；
 *  - buildCorpusProtocol：案卷模式的协议（定向优先 + 出处分级 + 反幻觉本模式修正 + 跨源三角验证）；
 *  - findIndexFile / generateIndexDraft：handoff 契约（先读 INDEX，缺则给草稿）。
 *
 * 隔离原则：本文件只被 --corpus 分支引用；非 corpus 运行完全不经过这里，行为零变化。
 * 合规：只读扫描 + 分析，不产出破解；不硬啃二进制/图像（路由到 tshark / 已有 dump / 承认看不了）。
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { looksLikeSourceTree } from './preflight.ts';

export type ArtifactType =
  | 'index' // INDEX/README/SUMMARY/HANDOFF/结论/总结 —— 交接/定向文件，最先读
  | 'analysis-md' // 其它 markdown 分析文档（二手结论/线索）
  | 'source-tree' // 反编译源码树（一手，rev-agent 核心能力）
  | 'frida' // Frida 脚本 + hook 输出（一手，运行时真相）
  | 'lsposed' // LSPosed / Xposed 日志（一手）
  | 'network' // pcap / pcapng / har（一手网络真相，需 tshark/jq 预处理）
  | 'native-dump' // so / il2cpp dump / ghidra 导出 / strings（一手，别人 dump 的文本）
  | 'config' // json / xml / yaml / manifest 等中间产物
  | 'image' // 截图（一手但 35B 无视觉，不可读）
  | 'other';

export interface CorpusEntry {
  /** 相对案卷根的路径 */
  rel: string;
  type: ArtifactType;
  isDir: boolean;
  sizeKB: number;
}

export interface CorpusManifest {
  root: string;
  entries: CorpusEntry[];
  /** 交接/定向文件（INDEX 等）的相对路径，按优先级排序 */
  indexFiles: string[];
  hasSourceTree: boolean;
  /** 各类型计数 */
  counts: Record<ArtifactType, number>;
  /** 扫描是否因为文件过多而截断 */
  truncated: boolean;
}

const INDEX_NAME = /^(index|readme|summary|handoff|结论|总结|概览|overview|findings)\b/i;
const SKIP_DIR = new Set(['node_modules', '.git', '.gradle', 'build', '.idea', '.svn']);
const MAX_ENTRIES = 500;
const MAX_DEPTH = 4;

/** 按文件名/扩展名判类型（不读内容，秒级）。 */
export function classifyArtifact(name: string, isDir: boolean): ArtifactType {
  const lower = name.toLowerCase();
  if (isDir) return 'other'; // 目录类型由扫描时的 source-tree 判定覆盖
  // markdown：交接文件优先
  if (/\.(md|markdown)$/.test(lower)) {
    return INDEX_NAME.test(name) ? 'index' : 'analysis-md';
  }
  if (/\.(pcap|pcapng|har)$/.test(lower)) return 'network';
  if (/frida|hook/.test(lower) && /\.(js|log|txt|json)$/.test(lower)) return 'frida';
  if (/lsposed|xposed/.test(lower)) return 'lsposed';
  if (
    /\.so$/.test(lower) ||
    /il2cpp|global-metadata|ghidra|\.i64$|\.gpr$/.test(lower) ||
    /(^|[_-])strings.*\.txt$/.test(lower) ||
    /\.(dump|dmp)$/.test(lower)
  ) {
    return 'native-dump';
  }
  if (/\.(png|jpg|jpeg|webp|gif|bmp)$/.test(lower)) return 'image';
  if (/\.(json|xml|ya?ml|toml|properties|cfg|ini)$/.test(lower)) return 'config';
  return 'other';
}

function emptyCounts(): Record<ArtifactType, number> {
  return {
    index: 0,
    'analysis-md': 0,
    'source-tree': 0,
    frida: 0,
    lsposed: 0,
    network: 0,
    'native-dump': 0,
    config: 0,
    image: 0,
    other: 0,
  };
}

/**
 * 扫描案卷根，产出 manifest。有界递归（限深 + 总条数上限）；
 * 遇到源码树只记一条 source-tree、不递归进去（否则 6.5 万 java 会撑爆）。
 */
export function scanCorpus(root: string): CorpusManifest {
  const entries: CorpusEntry[] = [];
  const counts = emptyCounts();
  let truncated = false;

  const walk = (dir: string, depth: number): void => {
    if (truncated || depth > MAX_DEPTH) return;
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (entries.length >= MAX_ENTRIES) {
        truncated = true;
        return;
      }
      if (name.startsWith('.') && name !== '.') continue;
      const abs = join(dir, name);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      const rel = abs.slice(root.length + 1);
      if (st.isDirectory()) {
        if (SKIP_DIR.has(name)) continue;
        // 源码树：记一条、不进去
        if (looksLikeSourceTree(abs)) {
          entries.push({ rel, type: 'source-tree', isDir: true, sizeKB: 0 });
          counts['source-tree']++;
          continue;
        }
        walk(abs, depth + 1);
      } else {
        const type = classifyArtifact(name, false);
        const sizeKB = Math.round(st.size / 1024);
        entries.push({ rel, type, isDir: false, sizeKB });
        counts[type]++;
      }
    }
  };

  walk(root, 0);

  const indexFiles = entries
    .filter((e) => e.type === 'index')
    .map((e) => e.rel)
    // 顶层的、名字更"总"的排前面
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));

  return {
    root,
    entries,
    indexFiles,
    hasSourceTree: counts['source-tree'] > 0,
    counts,
    truncated,
  };
}

const TYPE_LABEL: Record<ArtifactType, string> = {
  index: '交接/定向(先读)',
  'analysis-md': '前人分析MD(二手结论)',
  'source-tree': '反编译源码树(一手,可核验)',
  frida: 'Frida动态(一手,运行时真相)',
  lsposed: 'LSPosed/Xposed(一手)',
  network: '网络抓包(一手,需tshark/jq)',
  'native-dump': 'native/so dump(一手文本)',
  config: '配置/中间产物',
  image: '截图(35B看不了)',
  other: '其它',
};

/** 把 manifest 降成紧凑文本，注入首条消息当"案卷地图"。 */
export function buildManifestText(m: CorpusManifest): string {
  const order: ArtifactType[] = [
    'index',
    'analysis-md',
    'source-tree',
    'frida',
    'lsposed',
    'network',
    'native-dump',
    'config',
    'image',
    'other',
  ];
  const lines: string[] = [`【案卷清单】根目录: ${m.root}`];
  for (const t of order) {
    const items = m.entries.filter((e) => e.type === t);
    if (items.length === 0) continue;
    lines.push(`\n▸ ${TYPE_LABEL[t]} ×${items.length}`);
    for (const e of items.slice(0, 12)) {
      const size = e.isDir ? '(目录)' : `${e.sizeKB}KB`;
      lines.push(`   ${e.rel} ${size}`);
    }
    if (items.length > 12) lines.push(`   … 另 ${items.length - 12} 个`);
  }
  if (m.truncated) lines.push(`\n(文件过多，清单已截断到 ${MAX_ENTRIES} 条；用 shell 自行补看)`);
  return lines.join('\n');
}

/**
 * 案卷模式协议：追加到 system prompt 末尾（仅 --corpus 时）。
 * 定向优先 + 出处分级 + 反幻觉本模式修正 + 跨源三角验证 + 结构化案卷收尾。
 */
export function buildCorpusProtocol(m: CorpusManifest): string {
  const hasIndex = m.indexFiles.length > 0;
  const indexHint = hasIndex
    ? `案卷里有交接/定向文件（${m.indexFiles.slice(0, 3).join(' , ')}），开局第一件事就读它。`
    : `案卷里没有 INDEX/交接文件——先按上面的【案卷清单】环视，读最像"结论/总结"的 MD 定向。`;
  return [
    '━━━━━━━━ 案卷续分析模式（--corpus）━━━━━━━━',
    '你不是从裸 APK 从零逆向，而是接手一个"别人（更强的 agent / 人 + Frida/抓包/dump）已经分析过的案卷目录"继续分析。你的活是：读懂并核验前人结论、补链、交叉印证、扩展、答新问题——不是重新破案。',
    '',
    '① 定向优先（先看再动手）：' + indexHint + ' 搞清"已知什么、开放什么"，别把已经定论的东西重推一遍。',
    '',
    '② 出处纪律（每条结论都要标来源）：',
    '   · [前人MD] 二手结论/线索 —— 引用 doc:line；',
    '   · [代码] 一手，你在源码树里 read 到的 —— 引用 file:line；',
    '   · [动态trace] Frida/LSPosed 运行时观察；[网络] pcap/har；[推断] 你的推理。',
    '   混着二手结论和一手证据往下推是本模式最大的坑——务必分清。',
    '',
    '③ 反幻觉铁律（本模式版，务必遵守）：',
    '   · 前人 MD 的结论可以引用，但要标明是二手；',
    '   · 承重结论（最终定性 / 修复方案所依赖的那条）要尽量拿一手证据（代码/trace/抓包）核实，核实后升级为一手；',
    '   · 核不到就如实说"前人称 X，我未能独立证实"——绝不把二手当一手，也绝不因为"代码里没读到"就否定一条本属于动态/网络证据的前人结论；',
    '   · 不硬啃二进制/图像：pcap 用 tshark、so 读已有 dump 文本、截图承认"看不了图"退回前人转述。读不了的东西绝不编造内容。',
    '',
    '④ 跨源三角验证（本场景真正的增值）：一条结论尽量用两个以上来源互证——静态代码 ↔ 动态trace ↔ 网络抓包 ↔ 前人结论。例：前人说"VIP 走服务端校验"→在代码里找到该端点常量→在 har 里确认它真被调用且返回体含 entitlement→三方一致才定性。',
    '',
    '⑤ 收尾：用 append_note 把本轮结果记成带出处的"案卷更新"，分五类——已核实(一手) / 沿用(二手未核) / 与前人矛盾 / 新发现 / 仍开放。' +
      (hasIndex ? '' : ' 案卷原本没有 INDEX，请在收尾时额外产出一份 INDEX 草稿（已知结论+证据清单+开放问题），供下一轮强 agent/你自己接手。'),
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  ].join('\n');
}

/** 生成 INDEX.md 草稿正文（案卷无交接文件时，供 agent 收尾参考 / 用户留档）。 */
export function generateIndexDraft(m: CorpusManifest): string {
  const lines = [
    '# 案卷 INDEX（rev-agent 自动生成草稿）',
    '',
    `> 根目录: ${m.root}`,
    '> 这是本地小 agent 扫描案卷产出的定向草稿，供强 agent / 后续分析接手。请人工补全"已知结论"与"开放问题"。',
    '',
    '## 工件清单',
    buildManifestText(m),
    '',
    '## 已知结论（待填 / 由分析产出）',
    '- ',
    '',
    '## 开放问题（待续分析）',
    '- ',
  ];
  return lines.join('\n');
}
