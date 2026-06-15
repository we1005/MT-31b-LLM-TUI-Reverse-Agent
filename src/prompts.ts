/**
 * System prompt 加载器。
 * 从 ../LLM首轮注入prompt.md 抽取 §1（短版 ~400 token）或 §2（长版 ~1100 token）。
 * 切片规则：找 "## §N" 锚点 → 抓首个 ```...``` code fence 内文本。
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export type PromptSection = '§1' | '§2' | '§3' | '§4' | '§5';

const HERE = dirname(fileURLToPath(import.meta.url));
// 默认路径：src/prompts.ts → 上两级 → LLM首轮注入prompt.md
const DEFAULT_PATH = resolve(HERE, '..', '..', 'LLM首轮注入prompt.md');

export interface LoadPromptOptions {
  /** 哪一节，默认 §1 短版 */
  section?: PromptSection;
  /** 自定义路径覆盖（用于测试 / 用户自定义 prompt 文件） */
  path?: string;
}

export async function loadSystemPrompt(opts: LoadPromptOptions = {}): Promise<string> {
  const section = opts.section ?? '§1';
  const path = opts.path ?? process.env['REV_AGENT_PROMPT_PATH'] ?? DEFAULT_PATH;

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
  return fence[1].trim();
}

/** 列出所有可用的 prompt section（不解析正文，只看锚点）*/
export async function listSections(path = DEFAULT_PATH): Promise<PromptSection[]> {
  const raw = await readFile(path, 'utf-8');
  const matches = raw.matchAll(/^## (§\d)/gm);
  return Array.from(matches, m => m[1] as PromptSection);
}
