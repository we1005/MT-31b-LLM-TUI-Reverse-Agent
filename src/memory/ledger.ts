/**
 * Ledger —— 带外结构化台账（上下文记忆系统 · 阶段1，最高杠杆）。
 *
 * 设计依据：docs-resources/上下文记忆系统-架构设计.md。
 * 借鉴 Claude Code Session Memory + Hermes 结构化 ledger + MemGPT core-memory。
 *
 * 核心思想（治实测最大痛点"小模型不自律写台账/追对却不收尾/重复读同类"）：
 * - **系统维护，不指望模型自律**：agent 每次 read/grep 后，系统自动 observeToolResult 抽取 reads/greps，
 *   不靠模型自觉写。
 * - **带外**：ledger 不进 messages 持久历史，完全绕开 v6 tool-call↔result 配对 bug。
 *   **SWA 铁律**：台账每步临时拼到 messages **末尾** ephemeral、**绝不进 system 头部**（进 system 每步破前缀缓存，实测 0%）。
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
  // evicted=true 表示该范围的内容已被 compactHistory 折叠出上下文（模型已看不到原文）。
  // 用途：解「dedup 守卫 vs 驱逐后需重读」死锁——被驱逐的范围允许重读(hasRead 视其为未读)。
  ranges: Array<{ start: number; end: number; evicted?: boolean }>;
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

/** 从跳的一端文本抽第一个「类名/类.方法」规范标识（小写），用于按语义去重。抽不到=装饰/图行。 */
function hopKeyPart(s?: string): string {
  if (!s) return '';
  const m = s.match(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?/);
  return m ? m[0].toLowerCase() : '';
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
      // 2b-1 零-LLM 调用边派生：从「已 grep 的符号 + 本次 read 内容」确定性派生 caller→callee 边。
      // 消融开关 REV_AGENT_NO_EDGE_DERIVE=1 关闭（默认开）。错边零容忍——见 deriveEdges 的保守判据。
      if (!process.env['REV_AGENT_NO_EDGE_DERIVE'] && typeof result?.content === 'string') {
        this.deriveEdges(args.path, start, result.content);
      }
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

  // 干净的具名方法声明行：`...修饰符... 返回类型 名字(参数) {?`，行尾必须是 `{` 或结束（排除以 `;` 结尾的语句/字段/调用）。
  private static readonly SIG =
    /^\s*(?:@[\w$]+(?:\([^)]*\))?\s*)*(?:public|private|protected|static|final|synchronized|native|abstract|default|\s)*[\w$<>[\].,?\s]+\s+([\w$]+)\s*\([^;{]*\)\s*(?:throws[\w$.,\s]+)?\{?\s*$/;
  private static readonly BAD_NAME = /^(?:if|for|while|switch|catch|synchronized|return|new|lambda\$|access\$)/;
  private static esc(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * 2b-1 零-LLM 调用边派生（错边零容忍）。从「模型已 grep 的符号(callee 候选) + 本次 read 内容」
   * 确定性派生 caller→callee 边：内容里出现 `候选(` 调用点 → 向上找**干净具名外围方法签名**作 caller。
   * 保守判据（宁缺毋滥）：候选=grep 过的单个干净标识符(≥3 字符)；必须找到具名签名且非
   * lambda/合成/控制关键字；call 与签名之间跨 lambda `->` 或匿名类 `new X(){` 边界→归属不确定，跳过；
   * 向上扫描 ≤120 行。消融 REV_AGENT_NO_EDGE_DERIVE=1 关闭。
   */
  private deriveEdges(path: string, startLine: number, content: string): void {
    if (!content || this.greps.length === 0) return;
    const candidates = [...new Set(this.greps.map((g) => g.pattern))].filter((p) => /^[A-Za-z_$][\w$]{2,}$/.test(p));
    if (candidates.length === 0) return;
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      for (const cand of candidates) {
        if (!new RegExp(`\\b${Ledger.esc(cand)}\\s*\\(`).test(line)) continue;
        const encl = this.findEnclosingMethod(lines, i);
        if (!encl || encl === cand) continue;
        this.addDerivedHop(encl, cand, `${path.split('/').pop()}:${startLine + i}`);
      }
    }
  }

  /** 向上(≤120 行)找最近干净具名外围方法名；遇 lambda/匿名类边界或找不到 → 返回 null(不猜)。 */
  private findEnclosingMethod(lines: string[], callIdx: number): string | null {
    const stop = Math.max(0, callIdx - 120);
    for (let j = callIdx; j >= stop; j--) {
      const l = lines[j]!;
      if (j < callIdx && (/->\s*\{?/.test(l) || /\bnew\s+[\w$.]+\s*\([^)]*\)\s*\{/.test(l))) return null; // 跨 lambda/匿名类 → 不确定
      const m = l.match(Ledger.SIG);
      if (m) {
        const name = m[1]!;
        return Ledger.BAD_NAME.test(name) ? null : name; // 合成/控制关键字 → 不产边
      }
    }
    return null;
  }

  /** 加一条派生边(corroborated=true,源自实读内容);按语义键去重。 */
  private addDerivedHop(from: string, to: string, evidence: string): void {
    const key = `${hopKeyPart(from)}->${hopKeyPart(to)}`;
    if (this.hops.some((h) => `${hopKeyPart(h.from)}->${hopKeyPart(h.to)}` === key)) return;
    this.hops.push({ raw: `${from} → ${to} | ${evidence} (派生)`, from, to, evidence, corroborated: true });
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
      const parts = t.split(/→|->/).map((s) => s.trim());
      const from = parts[0]?.replace(/^跳\s*\d+\s*[:：]?\s*/, '').trim();
      const rest = parts.slice(1).join(' → ');
      const evMatch = rest.match(/([\w$/.]+\.(?:java|smali)\s*[:：]\s*\d+(?:-\d+)?|[\w$.]+:\d+)/);
      const evidence = evMatch ? evMatch[1] : undefined;
      const to = rest.split(/[|｜(（]/)[0]?.trim();
      // 按语义键(from→to 规范标识)去重，而非原文去重：折叠"同一跳的多种复述 + 最终 ASCII 链路图每行箭头"。
      // 治过度抽取：chm-medium 实测 3-4 真跳被抽成 19 跳、✓率仅 26%。两端抽不到类/方法标识 = 装饰/图连接行，丢弃。
      const fk = hopKeyPart(from);
      const tk = hopKeyPart(to);
      if (!fk || !tk) continue;
      const key = `${fk}→${tk}`;
      if (this.hops.some((h) => `${hopKeyPart(h.from)}→${hopKeyPart(h.to)}` === key)) continue;
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

  /**
   * read_file 去重守卫：该 path 的该行范围是否**仍在上下文里**已读过（覆盖即算）。
   * 关键(硬约束 e，解死锁)：只认**未被驱逐(evicted)**的覆盖范围——内容已被折叠出上下文的范围
   * 视为「未读」，允许模型重读，否则会出现「stub 让你重读→dedup 又拦住→拿不到已驱逐类体→迷路」的死锁。
   */
  hasRead(path: string, start: number, end: number): boolean {
    const e = this.reads.find((r) => r.path === path);
    if (!e) return false;
    return e.ranges.some((r) => r.start <= start && r.end >= end && !r.evicted);
  }

  /**
   * 标记某 path 的已读范围为「已驱逐」(内容被 compactHistory 折叠出上下文)。
   * path 级(而非按精确区间)——避免部分重叠区间的语义歧义;代价仅是偶尔多允许一次重读(无害),
   * 而漏标会导致死锁(有害),故取保守的 path 级。重读该 path 时 addRead 会重新加入 live 范围恢复去重。
   */
  markEvicted(path: string): void {
    const e = this.reads.find((r) => r.path === path);
    if (e) for (const r of e.ranges) r.evicted = true;
  }

  /** grep 去重守卫：同 pattern+path 是否已搜过。 */
  hasGrep(pattern: string, path: string): boolean {
    return this.greps.some((g) => g.pattern === pattern && g.path === path);
  }

  /** 渲染紧凑台账（有界）。注意：由 agent.callLLM 拼到 **messages 末尾** ephemeral，**绝不进 system 头部**（SWA 铁律）。 */
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
