/**
 * V0.3 笔记续传：从上一会话写好的工作笔记（/tmp/work-notes.md）构建续传上下文。
 *
 * 设计：
 * - 复用已有的 §3「续传版」system prompt（prompts.ts 已支持加载 §3 + 拼 §9）。
 * - 把整份笔记内容直接注入首条 user 消息，省掉 agent 再 read_file 笔记那一步。
 * - 抽出 §4「下一步」高亮给 agent，让它跳过已完成步骤直接接续。
 * - 笔记不存在 / 为空 → 明确报错，不静默退化成"重开新任务"。
 */
import { readFile, stat } from 'node:fs/promises';

export interface ResumeContext {
  ok: boolean;
  /** 注入给 agent 的首条 user 消息（含笔记全文 + 续传指令） */
  message?: string;
  /** 抽出的 §4「下一步」正文，供 CLI 回显用 */
  nextSteps?: string;
  /** 笔记原始行数（用于日志/预算估算提示） */
  noteLines?: number;
  error?: string;
}

/** 从笔记 markdown 里抽出「下一步」那一节的正文（§4，标题含"下一步"）。找不到返回空串。 */
export function extractNextSteps(noteText: string): string {
  const lines = noteText.split('\n');
  // 匹配形如 "## 4. 下一步..." / "## 下一步" / "#### 下一步"（标题里含"下一步"）
  const headingRe = /^#{1,6}\s.*下一步/;
  const anyHeadingRe = /^#{1,6}\s/;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headingRe.test(lines[i]!)) {
      start = i;
      break;
    }
  }
  if (start < 0) return '';
  // 收集到下一个同级/任意标题为止
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (anyHeadingRe.test(lines[i]!)) break;
    out.push(lines[i]!);
  }
  return out.join('\n').trim();
}

/**
 * 构建续传上下文。task 是用户在 --resume 时附带的一句话（默认"继续"）。
 */
export async function buildResumeContext(notesPath: string, task: string): Promise<ResumeContext> {
  // 1) 校验笔记存在
  try {
    await stat(notesPath);
  } catch {
    return {
      ok: false,
      error: `续传失败：笔记文件不存在 ${notesPath}。先跑一次正常任务生成笔记，或用 --notes 指定正确路径。`,
    };
  }

  // 2) 读取 + 校验非空
  let noteText: string;
  try {
    noteText = await readFile(notesPath, 'utf-8');
  } catch (e: unknown) {
    return { ok: false, error: `续传失败：读笔记出错 ${(e as Error).message}` };
  }
  if (noteText.trim().length === 0) {
    return { ok: false, error: `续传失败：笔记为空 ${notesPath}` };
  }

  const noteLines = noteText.split('\n').length;
  const nextSteps = extractNextSteps(noteText);
  const userTask = task.trim() || '继续';

  // 3) 拼首条消息：笔记全文 + 续传指令。§3 system prompt 已含"读笔记→跳 §4→接续"的协议，
  //    这里把笔记内容直接给出，避免 agent 再花一次 read_file。
  const nextStepsBlock = nextSteps
    ? `\n\n【上一轮记录的「下一步」（§4）——请从这里接续】\n${nextSteps}`
    : '\n\n（笔记里没找到明确的「下一步」§4，请通读笔记后自行判断从哪接续，并先补一条 §4。）';

  const message =
    `这是上一会话的工作笔记全文（来自 ${notesPath}），我们要从这里接着干。\n` +
    `你的任务：${userTask}\n` +
    `纪律：不要重跑笔记里已完成的步骤（§2 打勾项 / §1 已有摘要）；` +
    `不要触发 §6 禁区命令；每完成一步用 append_note 更新笔记；` +
    `结束时以「## 最终结论」输出本轮进展。` +
    nextStepsBlock +
    `\n\n===== 工作笔记全文开始 =====\n${noteText.trim()}\n===== 工作笔记全文结束 =====`;

  return { ok: true, message, nextSteps, noteLines };
}
