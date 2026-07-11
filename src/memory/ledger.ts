/**
 * Ledger —— 带外结构化台账（上下文记忆系统 · 阶段1，最高杠杆）。
 *
 * 设计依据：docs-resources/上下文记忆系统-架构设计.md。
 * 借鉴 Claude Code Session Memory + Hermes 结构化 ledger + MemGPT core-memory。
 *
 * 核心思想（治实测最大痛点"小模型不自律写台账/追对却不收尾/重复读同类"）：
 * - **系统维护，不指望模型自律**：agent 每次 read/grep 后，系统自动 observeToolResult 抽取 reads/greps，
 *   不靠模型自觉写。
 * - **带外**：ledger 不进 messages（只在 system prompt 尾部渲染），完全绕开 v6 tool-call↔result 配对 bug。
 * - **verbatim**：类名/方法/行号/URL 是逆向产物，一律原样存，绝不 LLM 转述。
 * - **收尾 O(1)**：链路图从已积累的 hops 直接渲染，不在巨上下文里重推。
 */

export interface Hop {
  /** 原始一行台账文本（verbatim） */
  raw: string;
  from?: string;
  to?: string;
  evidence?: string; // file:line
  /** 是否与 reads/greps 记录交叉核验一致 */
  corroborated?: boolean;
}

export interface ReadEntry {
  path: string;
  ranges: Array<{ start: number; end: number }>;
}

export interface GrepEntry {
  pattern: string;
  path: string;
  hitCount: number;
}

export interface LedgerState {
  goal: string;
  hops: Hop[];
  reads: ReadEntry[];
  greps: GrepEntry[];
}

export class Ledger {
  private goal = '';
  private hops: Hop[] = [];
  private reads: ReadEntry[] = [];
  private greps: GrepEntry[] = [];

  /** verbatim 记住用户原始任务（首条 user 消息）。 */
  setGoal(raw: string): void {
    if (!this.goal) this.goal = raw.trim().slice(0, 400);
  }

  /**
   * 系统自动从一次工具结果抽取结构化台账（零 LLM）。
   * read_file → reads[]；grep → greps[]（含命中数）。其余工具忽略。
   */
  // biome-ignore lint/suspicious/noExplicitAny: 工具结果异构
  observeToolResult(name: string, args: any, result: any): void {
    if (!args || typeof args !== 'object') return;
    if (name === 'read_file' && typeof args.path === 'string') {
      const start = typeof args.start === 'number' ? args.start : 1;
      const total = result?.range ? result.range.end : start + (typeof args.lines === 'number' ? args.lines : 200) - 1;
      this.addRead(args.path, start, total);
    } else if (name === 'grep' && typeof args.pattern === 'string' && typeof args.path === 'string') {
      const hitCount = Array.isArray(result?.hits) ? result.hits.length : 0;
      this.greps.push({ pattern: args.pattern, path: args.path, hitCount });
      // 去重：同 pattern+path 只留最新
      const key = `${args.pattern}@@${args.path}`;
      this.greps = this.greps.filter((g, i, arr) => `${g.pattern}@@${g.path}` !== key || i === arr.length - 1);
    }
  }

  private addRead(path: string, start: number, end: number): void {
    let e = this.reads.find((r) => r.path === path);
    if (!e) {
      e = { path, ranges: [] };
      this.reads.push(e);
    }
    e.ranges.push({ start, end });
  }

  /**
   * 从 assistant 正文捞出"跳N: 源 → 目标 | 证据 file:line"式台账行，提升为结构化 Hop（正则，零 LLM）。
   * 兼容多种写法：`跳1: A.x → B.y | 证据 C.java:12`、`A.x → B.y (file:line)` 等。
   * 与 reads/greps 交叉核验证据行，一致则标 corroborated。返回本次新增 hop 数。
   */
  promoteFromProse(text: string): number {
    if (!text) return 0;
    let added = 0;
    // 逐行找含箭头的台账样式行
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!/→|->/.test(t)) continue;
      if (!/跳\s*\d|[A-Za-z]\w*\.\w+|\.java|\.smali|:[0-9]/.test(t)) continue;
      // 去重：同一行原文不重复记
      if (this.hops.some((h) => h.raw === t)) continue;
      const parts = t.split(/→|->/).map((s) => s.trim());
      const from = parts[0]?.replace(/^跳\s*\d+\s*[:：]?\s*/, '').trim();
      const rest = parts.slice(1).join(' → ');
      const evMatch = rest.match(/([\w$/.]+\.(?:java|smali)\s*[:：]\s*\d+(?:-\d+)?|[\w$.]+:\d+)/);
      const evidence = evMatch ? evMatch[1] : undefined;
      const to = rest.split(/[|｜(（]/)[0]?.trim();
      const hop: Hop = { raw: t, from, to, evidence };
      // 交叉核验：证据 file:line 是否落在已 read 的范围里
      if (evidence) {
        const fileMatch = evidence.match(/([\w$/.]+\.(?:java|smali))/);
        if (fileMatch) {
          const f = fileMatch[1]!;
          hop.corroborated = this.reads.some((r) => r.path.includes(f) || f.includes(r.path.split('/').pop() ?? ''));
        }
      }
      this.hops.push(hop);
      added++;
    }
    return added;
  }

  /** 已确认跳数（取代脆弱的正则计数 hopCount）。 */
  hopCount(): number {
    return this.hops.length;
  }

  /** 记忆表现遥测：台账各项计数 + 交叉核验的跳数。 */
  stats(): { hops: number; corroborated: number; reads: number; greps: number } {
    return {
      hops: this.hops.length,
      corroborated: this.hops.filter((h) => h.corroborated).length,
      reads: this.reads.length,
      greps: this.greps.length,
    };
  }

  /** read_file 去重守卫：该 path 的该行范围是否已读过（覆盖即算）。 */
  hasRead(path: string, start: number, end: number): boolean {
    const e = this.reads.find((r) => r.path === path);
    if (!e) return false;
    return e.ranges.some((r) => r.start <= start && r.end >= end);
  }

  /** grep 去重守卫：同 pattern+path 是否已搜过。 */
  hasGrep(pattern: string, path: string): boolean {
    return this.greps.some((g) => g.pattern === pattern && g.path === path);
  }

  /** 渲染进 system prompt 尾部的紧凑台账（有界，默认 ≤1200 token 估算）。 */
  render(maxChars = 4000): string {
    const lines: string[] = [];
    if (this.goal) lines.push(`目标: ${this.goal}`);
    if (this.hops.length) {
      lines.push(`已确认链路跳(${this.hops.length}):`);
      for (const h of this.hops) lines.push(`  ${h.raw}${h.corroborated ? ' ✓' : ''}`);
    }
    if (this.reads.length) {
      const rs = this.reads.slice(-12).map((r) => `${r.path}(${r.ranges.length}段)`);
      lines.push(`已读类(${this.reads.length}): ${rs.join(', ')}`);
    }
    if (this.greps.length) {
      const gs = this.greps.slice(-8).map((g) => `"${g.pattern}"→${g.hitCount}`);
      lines.push(`已搜(${this.greps.length}): ${gs.join(', ')}`);
    }
    let out = lines.join('\n');
    if (out.length > maxChars) out = `${out.slice(0, maxChars)}\n…(台账过长已截，完整见磁盘)`;
    return out;
  }

  /** 收尾时把已积累的 hops 渲染成链路图草稿（O(1)，不在巨上下文重推）。 */
  renderChainGraph(): string {
    if (!this.hops.length) return '（尚无已确认的链路跳）';
    const arrows = this.hops.map((h) => (h.from && h.to ? `${h.from} → ${h.to}` : h.raw));
    return arrows.join('\n');
  }

  toJSON(): LedgerState {
    return { goal: this.goal, hops: this.hops, reads: this.reads, greps: this.greps };
  }

  fromJSON(s: LedgerState): void {
    this.goal = s.goal ?? '';
    this.hops = s.hops ?? [];
    this.reads = s.reads ?? [];
    this.greps = s.greps ?? [];
  }
}
