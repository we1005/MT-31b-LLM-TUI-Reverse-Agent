/**
 * --once 模式：非交互执行单任务，无 TUI，纯 stdout/stderr。
 * 适用：脚本化、CI/CD、demo.sh 验收测试。
 */
import { join } from 'node:path';
import { Agent } from '../agent.ts';
import { type AdvisorWiring, wireAdvisor } from '../advisor.ts';
import { Budget } from '../budget.ts';
import { type Backend, DEFAULT_CONFIG } from '../config.ts';
import { createLLM } from '../llm.ts';
import { preflightSourceTree } from '../preflight.ts';
import { buildCorpusProtocol, buildManifestText, scanCorpus } from '../corpus.ts';
import { probeStack } from '../stack-probe.ts';
import { learnPlaybookFromLedger, loadLearned, matchPlaybooks, renderPlaybookBlock, saveLearned } from '../playbook.ts';
import { loadSystemPrompt } from '../prompts.ts';
import { buildResumeContext } from '../resume.ts';
import { builtinTools, ToolRegistry } from '../tools/index.ts';

export interface RunOnceOpts extends AdvisorWiring {
  task: string;
  /** 从工作笔记续传：用 §3 续传 prompt + 注入笔记为首条消息 */
  resume?: boolean;
  backend: Backend;
  model?: string;
  baseURL?: string;
  apiKey?: string;
  verbose: boolean;
  autoApprove: boolean;
  workdir?: string;
  /** --corpus：案卷续分析模式。指向"强 agent 前置分析产物 + 动态/网络证据"的案卷根目录，
   *  agent 接手它续分析（定向 + 出处分级 + 跨源三角验证），而非从裸源码树从零逆向。 */
  corpus?: string;
  budget: number;
  notesPath: string;
  /** --ask-when-stuck：卡住时输出困境报告 + exit=3 停机等外部思路（配合 --strategy 重跑）。 */
  askWhenStuck?: boolean;
  /** --strategy：用户/更强模型给的分析思路，前置注入让 agent 按此分析（配合上一轮 exit=3 的困境报告使用）。 */
  strategy?: string;
}

function color(s: string, code: number): string {
  return process.stderr.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s;
}
const dim = (s: string) => color(s, 90);
const cyan = (s: string) => color(s, 36);
const green = (s: string) => color(s, 32);
const yellow = (s: string) => color(s, 33);
const red = (s: string) => color(s, 31);

export async function runOnce(opts: RunOnceOpts): Promise<number> {
  // 案卷模式：cwd = 案卷根（相对路径/grep 覆盖整个案卷）；否则 cwd = --workdir（源码树）。
  if (opts.corpus) {
    process.chdir(opts.corpus);
  } else if (opts.workdir) {
    process.chdir(opts.workdir);
  }

  // 案卷模式：秒级扫案卷根产出 manifest（源码树只记一条、不递归进去）。空目录/不存在 → fail-fast。
  // 案卷模式自带定向，跳过"源码级任务缺源码树"的 preflight（案卷顶层本就是一堆 MD/pcap/日志）。
  let corpusManifest: ReturnType<typeof scanCorpus> | undefined;
  if (opts.corpus) {
    corpusManifest = scanCorpus(process.cwd());
    if (corpusManifest.entries.length === 0) {
      process.stderr.write(
        yellow(`⚠ 案卷目录为空或不可读：${opts.corpus}\n`) +
          `--corpus 应指向"强 agent 前置分析产物"的目录（MD 结论 / Frida trace / pcap / dump / 反编译源码树等）。\n`,
      );
      return 2;
    }
  } else if (!opts.resume) {
    // P0 前置校验：源码级任务缺完整源码树 → 秒级 fail-fast + 给配方，别让 agent 撞 123s 超时墙。
    // 续传模式跳过（笔记里已隐含源码树前提，且 resume 有自己的校验）。见「三提议深度分析」§2。
    const pf = preflightSourceTree(opts.task, opts.workdir);
    if (!pf.ok) {
      process.stderr.write(yellow(`⚠ 前置校验未通过：\n`) + `${pf.message}\n`);
      return 2; // 区别于运行错误(1)：2 = 前置条件不满足，需用户补输入
    }
  }

  // P1 主动栈探测前置：确定性地替模型探栈（定位原始 APK → unzip -l 看 lib/assets 签名），
  // 把权威栈报告注入首条消息，从源头掐掉 Round-3 头号失败模式——不 unzip 就断言"无 native/纯 Java"。
  // 仅对源码级/审计/corpus 任务生效；续传模式跳过（笔记里已含探索前提）。
  const stackReport = opts.resume ? undefined : probeStack({ workdir: opts.workdir, corpus: opts.corpus, task: opts.task });

  // 续传：先构建续传上下文（读笔记 + 校验），失败直接退出，不静默退化成新任务。
  let resumeMessage: string | undefined;
  if (opts.resume) {
    const ctx = await buildResumeContext(opts.notesPath, opts.task);
    if (!ctx.ok) {
      process.stderr.write(red(`✗ ${ctx.error}\n`));
      return 1;
    }
    resumeMessage = ctx.message;
    process.stderr.write(
      dim(`[rev-agent] 续传模式：笔记 ${opts.notesPath}（${ctx.noteLines} 行）\n`) +
        (ctx.nextSteps
          ? cyan('  下一步（§4）：\n') + dim(ctx.nextSteps.split('\n').map((l) => `    ${l}`).join('\n') + '\n')
          : yellow('  笔记无明确 §4 下一步，agent 将通读后自行判断\n')),
    );
  }

  // 续传用 §3；否则 §1（--verbose 用 §2）。§9 避坑块会自动拼到 §1/§2/§3 末尾。
  const section = opts.resume ? '§3' : opts.verbose ? '§2' : '§1';
  let systemPrompt = await loadSystemPrompt({ section });
  // 案卷模式：把案卷协议（定向 + 出处分级 + 反幻觉本模式修正 + 跨源三角验证）追加到 system 末尾。
  // 只在 --corpus 时生效——非 corpus 运行的 system prompt 完全不变。
  if (corpusManifest) {
    systemPrompt = `${systemPrompt}\n\n${buildCorpusProtocol(corpusManifest)}`;
  }
  const model = createLLM({
    backend: opts.backend,
    model: opts.model,
    baseURL: opts.baseURL,
    apiKey: opts.apiKey,
  });
  const tools = new ToolRegistry(builtinTools(opts.notesPath));
  const budget = new Budget(opts.budget ?? DEFAULT_CONFIG.tokenBudget);

  process.stderr.write(
    dim(
      `[rev-agent] backend=${opts.backend} model=${opts.model ?? 'default'} ` +
        `prompt=${section} (${Buffer.byteLength(systemPrompt)} bytes) ` +
        `budget=${budget.max}\n`,
    ),
  );
  if (stackReport) {
    const s = stackReport.dataGap
      ? '未定位到 APK/看不到 lib → 诚实"无法判栈"(防 false-negative)'
      : `APK=${stackReport.apkPath ? stackReport.apkPath.split('/').pop() : '?'} dex=${stackReport.dexCount} native=${stackReport.hasNativeSo ? 'Y' : 'N'}` +
        (stackReport.hits.length ? ` 非dex栈:[${stackReport.hits.map((h) => h.stack).join(', ')}]` : ' 未见非dex栈');
    process.stderr.write(cyan(`[rev-agent] 栈探测：`) + dim(`${s}\n`));
  }
  if (corpusManifest) {
    const c = corpusManifest.counts;
    process.stderr.write(
      cyan(`[rev-agent] 案卷模式：`) +
        dim(
          `${corpusManifest.entries.length} 工件 ` +
            `(MD结论=${c['analysis-md']} 源码树=${c['source-tree']} frida=${c.frida} ` +
            `网络=${c.network} native-dump=${c['native-dump']} 交接=${c.index})` +
            (corpusManifest.indexFiles[0] ? ` 先读:${corpusManifest.indexFiles[0]}` : ' 无INDEX(将建议产出草稿)') +
            '\n',
        ),
    );
  }

  // 混合后端：--consult-cloud 时卡住→脱敏问云端顾问拿思路续跑（getLedger 前向引用 agent，运行期才调用）。
  let agentRef: Agent;
  const advisor = wireAdvisor(
    opts,
    () => agentRef.ledgerState(),
    (m) => process.stderr.write(cyan('[顾问] ') + dim(m) + '\n'),
  );

  const agent = new Agent({
    model,
    tools,
    budget,
    systemPrompt,
    // 云端顾问优先：开启则卡住→脱敏问云端拿思路续跑（escalate=true, halt=false）；
    // 否则沿用 --ask-when-stuck 的「输出困境报告 + 停机(stuckHalted) 等外部 --strategy」行为。
    escalateWhenStuck: advisor.enabled || !!opts.askWhenStuck,
    haltWhenStuck: !advisor.enabled && !!opts.askWhenStuck,
    maxEscalations: advisor.enabled ? advisor.maxEscalations : 3,
    ...(advisor.askStrategy ? { askStrategy: advisor.askStrategy } : {}),
    approve: async (call) => {
      if (opts.autoApprove) {
        process.stderr.write(yellow(`  [auto-approve] ${call.name}(${JSON.stringify(call.args).slice(0, 100)})\n`));
        return true;
      }
      // --once 默认拒绝 write 类，避免无人值守误改文件
      process.stderr.write(
        red(`  [denied: write 类工具默认拒，加 --auto-approve 允许] ${call.name}\n`),
      );
      return false;
    },
  });
  agentRef = agent; // 供云端顾问 getLedger 前向引用（运行期 stuckIntervene 内才调用，此时已赋值）

  // 流式：assistant 正文增量直接进 stdout（评分脚本读 stdout，增量拼起来=完整答案）。
  agent.on('assistantDelta', (delta) => {
    process.stdout.write(delta);
  });
  // 流式：思考链增量进 stderr（暗灰，不污染被评分的 stdout），消灭 Qwen 推理期死屏。
  let reasoningActive = false;
  agent.on('reasoningDelta', (delta) => {
    if (!reasoningActive) {
      process.stderr.write(dim('\n💭 '));
      reasoningActive = true;
    }
    process.stderr.write(dim(delta));
  });
  // 一轮结束的完整 assistant 文本：只补一个换行收尾（正文已由 assistantDelta 流式写过）。
  agent.on('assistant', () => {
    if (reasoningActive) {
      process.stderr.write('\n');
      reasoningActive = false;
    }
    process.stdout.write('\n');
  });
  agent.on('toolCall', (call) => {
    process.stderr.write(cyan(`→ ${call.name} `) + dim(JSON.stringify(call.args).slice(0, 120)) + '\n');
  });
  agent.on('toolResult', (_id, name, result) => {
    const s = typeof result === 'string' ? result : JSON.stringify(result);
    process.stderr.write(dim(`  ← ${name}: ${s.slice(0, 200)}${s.length > 200 ? '...' : ''}\n`));
  });
  agent.on('toolDenied', (_id, name, reason) => {
    process.stderr.write(red(`  ✗ ${name} denied: ${reason}\n`));
  });
  agent.on('budget', (used, max, level) => {
    if (level !== 'green') {
      const c = level === 'yellow' ? yellow : red;
      process.stderr.write(c(`  [budget ${used}/${max} ${level}]\n`));
    }
  });
  agent.on('warn', (msg) => process.stderr.write(yellow(`⚠ ${msg}\n`)));
  agent.on('error', (e) => process.stderr.write(red(`✗ ${e.message}\n`)));
  // 卡住求助报告：--once 无交互，打到 stderr 供用户查看（随后 agent 回退强制收尾）。
  agent.on('stuck', (report) => process.stderr.write(`\n${yellow(report)}\n`));

  // 续传时首条消息是注入了笔记全文的续传上下文；否则是用户原始任务。
  // 关键修复：chdir 只让工具的相对路径生效，但 LLM 不知道自己在哪个目录 → 会幻觉路径满世界找。
  // 非续传时把「当前工作目录」显式前缀进任务，让 agent 直接从这里开始，不要去猜/搜。
  // P1 栈报告块：注入所有非续传 firstMessage（权威探栈结论，防 false-negative）。
  const stackBlock = stackReport ? `\n\n${stackReport.verdict}` : '';
  let firstMessage = resumeMessage ?? opts.task;
  if (!resumeMessage) {
    const cwd = process.cwd();
    if (corpusManifest) {
      // 案卷模式：cwd + 案卷清单 +（若有）交接文件正文 + 任务。让 agent 开局就有案卷地图，先定向再动手。
      let indexBlock = '';
      const top = corpusManifest.indexFiles[0];
      if (top) {
        try {
          const raw = await Bun.file(join(process.cwd(), top)).text();
          const clip = raw.length > 4000 ? `${raw.slice(0, 4000)}\n…(交接文件过长已截断，需要更多用 read_file)` : raw;
          indexBlock = `\n\n【交接/定向文件 ${top}（前人留下的，先读懂它）】\n${clip}`;
        } catch {
          // 读不到就算了，清单里已标出它的位置
        }
      }
      firstMessage =
        `【你的当前工作目录 = 案卷根（所有相对路径基于此，直接用，不要去别处搜索）】\n${cwd}\n\n` +
        `${buildManifestText(corpusManifest)}${indexBlock}${stackBlock}\n\n` +
        `【任务】\n${opts.task}`;
    } else {
      firstMessage =
        `【你的当前工作目录（所有相对路径基于此，反编译源码就在这里，直接用，不要去别处搜索）】\n${cwd}${stackBlock}\n\n` +
        `【任务】\n${opts.task}`;
    }
    // MVP-3 栈感知主动注入 playbook（**只作 context·可无视**，不作 control）：按 stack-probe 确凿命中的
    // 栈 + 任务关键词，把"做法/套路"拼进首条消息末尾。系统主动推（解"弱模型不会自查知识库"悖论），
    // 但明确标"参考·可无视"，模型可不理——绝不"检测到 X 就强制执行 Y"。
    // REV_NO_PLAYBOOK=1 关掉注入(用于 A/B 测 playbook 效果)。
    const pbs = process.env['REV_NO_PLAYBOOK'] === '1' ? [] : matchPlaybooks(stackReport, opts.task);
    const pbBlock = renderPlaybookBlock(pbs);
    if (pbBlock) {
      firstMessage += `\n\n${pbBlock}`;
      process.stderr.write(dim(`[rev-agent] 注入 ${pbs.length} 条参考 playbook：${pbs.map((p) => p.id).join(', ')}\n`));
    }
  }
  // --strategy：把用户/更强模型的思路前置注入（最高优先级），配合上一轮 exit=3 困境报告，按思路重新分析。
  if (opts.strategy?.trim()) {
    firstMessage =
      `【用户/更强模型提供的分析思路——请严格按此执行，不要重复之前无效的做法】\n${opts.strategy.trim()}\n\n${firstMessage}`;
    process.stderr.write(cyan(`[rev-agent] 已注入 --strategy 思路（${opts.strategy.trim().length} 字），按此分析\n`));
  }
  agent.addUserMessage(firstMessage);

  try {
    await agent.run();
    // 卡住停机(--ask-when-stuck 且无思路):写困境报告到文件 + exit=3,提示带 --strategy 重跑。
    if (agent.stuckHalted) {
      const stuckFile = `${opts.notesPath}.stuck.md`;
      try {
        await Bun.write(stuckFile, agent.stuckReport);
      } catch {
        // 写文件失败不影响退出(报告已 emit 到 stderr)
      }
      process.stderr.write(
        yellow(`\n🆘 已卡住停机(exit=3)。困境报告已写入 ${stuckFile}。\n`) +
          cyan(
            `把该报告交给更强的模型取得思路后，用以下命令按思路续跑：\n` +
              `  rev-agent --once "${opts.task.slice(0, 40)}..." --workdir ${opts.workdir ?? process.cwd()} --ask-when-stuck --strategy "<粘贴思路>"\n`,
          ),
      );
      return 3;
    }
    // MVP-4 playbook 自动生长（opt-in REV_LEARN_PLAYBOOK=1，默认关避免意外写 ~/.config）：
    // 从本次**解出**的 ledger 归纳一条 learned playbook 落盘，供将来同栈任务主动注入（MVP-3）。
    if (process.env['REV_LEARN_PLAYBOOK'] === '1') {
      const pb = learnPlaybookFromLedger(agent.ledgerState(), stackReport);
      if (pb) {
        const learned = loadLearned();
        const dup = learned.some((x) => JSON.stringify(x.triggerStacks) === JSON.stringify(pb.triggerStacks) && x.title === pb.title);
        if (!dup) {
          saveLearned([...learned, pb]);
          process.stderr.write(dim(`[rev-agent] 自动归纳 learned playbook：${pb.id}\n`));
        }
      }
    }
    process.stderr.write(green(`\n✓ done (steps=${agent.step} budget=${budget.used}/${budget.max})\n`));
    return 0;
  } catch (e) {
    process.stderr.write(red(`✗ failed: ${(e as Error).message}\n`));
    return 1;
  }
}
