/**
 * System prompt 加载器。
 * 从 ../LLM首轮注入prompt.md 抽取 §1（短版 ~400 token）或 §2（长版 ~1100 token）。
 * 切片规则：找 "## §N" 锚点 → 抓首个 ```...``` code fence 内文本。
 */
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export type PromptSection = '§1' | '§2' | '§3' | '§4' | '§5';

const HERE = dirname(fileURLToPath(import.meta.url));
// 多个候选路径，按顺序探测（兼容迁移前/后 + 自定义部署）
const CANDIDATE_PATHS = [
  // 迁移后：rev-agent/docs-resources/LLM首轮注入prompt.md
  resolve(HERE, '..', 'docs-resources', 'LLM首轮注入prompt.md'),
  // 项目根：rev-agent/LLM首轮注入prompt.md
  resolve(HERE, '..', 'LLM首轮注入prompt.md'),
  // 迁移前：rev-agent/../LLM首轮注入prompt.md
  resolve(HERE, '..', '..', 'LLM首轮注入prompt.md'),
];

async function findPromptFile(): Promise<string> {
  for (const p of CANDIDATE_PATHS) {
    try {
      await stat(p);
      return p;
    } catch {
      // skip
    }
  }
  throw new Error(
    `prompt 文件未找到。已尝试：\n  ${CANDIDATE_PATHS.join('\n  ')}\n` +
      `设 REV_AGENT_PROMPT_PATH env var 覆盖路径。`,
  );
}

export interface LoadPromptOptions {
  /** 哪一节，默认 §1 短版 */
  section?: PromptSection;
  /** 自定义路径覆盖（用于测试 / 用户自定义 prompt 文件） */
  path?: string;
}

export async function loadSystemPrompt(opts: LoadPromptOptions = {}): Promise<string> {
  const section = opts.section ?? '§1';
  const path = opts.path ?? process.env['REV_AGENT_PROMPT_PATH'] ?? (await findPromptFile());

  const raw = await readFile(path, 'utf-8');
  const startMarker = `## ${section}`;
  const start = raw.indexOf(startMarker);
  if (start < 0) {
    throw new Error(`prompt section ${section} not found in ${path}`);
  }
  // 下一节锚点：## §X（X 是 1-5 任意值）
  const nextMatch = raw.slice(start + startMarker.length).match(/\n## §\d/);
  const end = nextMatch ? start + startMarker.length + nextMatch.index! : raw.length;
  const sectionText = raw.slice(start, end);

  // 抓首个 ``` code fence
  const fence = sectionText.match(/```([\s\S]*?)```/);
  if (!fence) {
    throw new Error(`no code fence found in section ${section}`);
  }
  let prompt = fence[1].trim();

  // §9「通用避坑块」自动追加到实操类 section（§1/§2/§3）末尾。
  // 消 CTF benchmark 暴露的高频失败模式，且不改 §1–§8 原文。§9 缺失则跳过（向后兼容）。
  if (section === '§1' || section === '§2' || section === '§3') {
    const guard = extractGuardBlock(raw);
    if (guard) prompt = `${prompt}\n\n${guard}`;
  }
  return prompt;
}

/** 抽 §9 里的首个 code fence（通用避坑块），无 §9 返回 null */
function extractGuardBlock(raw: string): string | null {
  const start = raw.indexOf('## §9');
  if (start < 0) return null;
  const nextMatch = raw.slice(start + 5).match(/\n## §\d/);
  const end = nextMatch ? start + 5 + nextMatch.index! : raw.length;
  const fence = raw.slice(start, end).match(/```([\s\S]*?)```/);
  return fence ? fence[1].trim() : null;
}

/** 列出所有可用的 prompt section（不解析正文，只看锚点）*/
export async function listSections(path?: string): Promise<PromptSection[]> {
  const p = path ?? (await findPromptFile());
  const raw = await readFile(p, 'utf-8');
  const matches = raw.matchAll(/^## (§\d)/gm);
  return Array.from(matches, m => m[1] as PromptSection);
}
