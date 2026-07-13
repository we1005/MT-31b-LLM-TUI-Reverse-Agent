# Mechanisms（机制详解）

这个 agent 的能力不靠"更聪明的提示"，而靠一层层**把逆向负担从弱模型移到框架**的机制。下面按类别逐条列出（`位置` = 主 file:line，`开关` = env/CLI，"—"表示无开关恒生效）。设计红线：**框架只按硬事实注 context + 按资源收 budget，永不替 agent 决定"下一步/是否完成"**。

架构图与单步循环见 **[[Architecture]]**。

---

## 🧵 SWA 稳定前缀（治"越聊越卡"）

llama.cpp 的 SWA/滑窗只复用**逐字节相同的最长公共前缀**的 KV。动态内容一旦混进 system 头部，前缀从第一个 token 就断 → 每步全量重算。

| 机制 | 位置 | 做什么 | 治什么 | 开关 |
|---|---|---|---|---|
| 台账拼 messages 末尾 ephemeral | `agent.ts:322` | system 逐字节静态，台账每步临时拼到 messages 末尾（不写回历史），保 `[静态system+只追加历史]` 稳定前缀 | 台账放 system 头部且每步变→前缀断→全量重算→越聊越卡 | `REV_AGENT_LEDGER_IN_SYSTEM=1`（A/B 退回坏做法） |
| 折叠阈值门控 | `agent.ts:445` | 只有真实 ctx 超 `compactThreshold(160k)` 才折叠一次，日常几k~几十k 不折 | 折叠改历史中段=破坏前缀=全量重算；256k 装得下时保前缀最省 | `compactThreshold` |
| 前缀缓存命中率遥测 | `agent.ts:763` | 每步算 `cachedInputTokens/inputTokens`，聚合进 SCORECARD `cache_avg/min` | 量化稳定前缀是否真生效（实测 0%→97%） | — |

## 🧠 记忆（结构化台账）

| 机制 | 位置 | 做什么 | 治什么 | 开关 |
|---|---|---|---|---|
| 结构化台账（带外/verbatim） | `memory/ledger.ts:53` | 系统维护 goal/hops/reads/greps，不进持久 messages，类名/行号原样存不 LLM 转述 | 小模型不自律写台账；带外绕开 AI-SDK v6 tool-call↔result 配对 bug；verbatim 保逆向产物精确 | `REV_AGENT_NO_LEDGER_RENDER=1` |
| observeToolResult 自动抽取 | `memory/ledger.ts:69` | 每次 read/grep 后零-LLM 自动抽路径/行范围/pattern/命中数进台账 | 不指望模型自觉写，做唯一真相源 | — |
| 零-LLM 调用边派生 | `memory/ledger.ts:113` | 从"已 grep 符号+本次 read 内容"确定性派生 caller→callee 边（跨 lambda/匿名类边界即弃） | 自动补链路跳，错边零容忍 | `REV_AGENT_NO_EDGE_DERIVE=1` |
| promoteFromProse 捞跳+去重 | `memory/ledger.ts:156` | 从正文正则捞"跳N: A→B\|证据 file:line"升级为结构化 Hop，按 from→to 去重 | 治过度抽取（3-4 真跳被抽成 19 跳） | — |
| 交叉核验 corroborated | `memory/ledger.ts:179` | 跳的证据 file:line 与已读范围比对，落在已读文件里标 ✓ | 区分"真读到证实的跳"vs"仅口头声称" | — |
| markEvicted 解死锁 | `memory/ledger.ts:223` | 被折叠出上下文的范围标 evicted，允许重读 | 解"stub 让你重读→dedup 又拦→迷路"死锁 | — |
| renderChainGraph O(1) 草稿 | `memory/ledger.ts:255` | 收尾从已积累 hops 直接渲染链路图，不在巨上下文里重推 | 省 token 且不丢已确认跳 | — |
| budget 线性计量 | `agent.ts:756` | 每步只加本轮 `outputTokens`，绝不加 totalTokens | totalTokens 含增长历史 prefill，累加是 super-linear 伪量（123k 伪 vs 6.7k 真） | — |
| contextTokens 诚实标尺 | `agent.ts:402` | 对当前 messages 估真实 token | 与累加伪量区分，驱动折叠/硬止损 | — |
| Budget 70/90% 告警 | `budget.ts:39` | 70% 黄牌建议存盘、90% 红牌强制提示重启 | 提醒及时存盘；红牌参与硬止损 | `--budget`（默认 80k） |

## 🛡️ 守卫（健壮性止损，软化后仍守底线）

| 机制 | 位置 | 做什么 | 治什么 | 开关 |
|---|---|---|---|---|
| dedup 去重守卫 | `agent.ts:493` | 重复读同范围/搜同 pattern+path 时不真跑，回喂台账 | 小模型反复读同一幻觉类/搜同 pattern 空转烧 token | — |
| 进度停滞止损 stallCap | `agent.ts:642` | 连续 N 步 (reads+greps+hops+shell) 无增长即触发 | 堵"有进展后又卡死原地打转" | `stallCap`（默认 3） |
| grep 空转止损 readHopStallCap | `agent.ts:665` | 只看 reads+hops：连续 N 步没读新代码/没连新跳（哪怕每步换 grep） | 补 stall 盲区（每步换 grep 让 stall 永不触发撞墙钟） | `readHopStallCap`（默认 5） |
| 迷路干预 exploreCap | `agent.ts:688` | hops=0 每积累 N 次工具调用介入：先"换反向追踪"，≥2 次判起点难定位强制收尾 | 一次性提醒不够，agent 会迷路到 maxSteps | `exploreCap`（默认 8） |
| 足量收尾软提示 enoughHops | `agent.ts:724` | 追链 hops≥N 或定点 reads 足量且没结论→软提示"证据够就写结论"（不硬砍） | 小模型缺"追够了该停手"自律；软化守卫后补回速度 | `enoughHops`（默认 4） |
| 断链续跑 nudge | `agent.ts:145` | 无 tool_call 时判尾句是否"让我/进入阶段/let me"等续跑意图或裸标题，命中则注入指令 | benchmark 里 agent 常打印"进入阶段2"后直接 done，答案从未写出 | `maxNudges`（默认 2） |
| 先读方法体 nudge（反幻觉） | `agent.ts:818` | reads=0 就想下结论时注入"grep 只定位、必须 read_file 读方法体核实" | 治只 grep 不 read→凭回显+先验幻觉编造荒谬机制 | — |
| 结论检测（## 最终结论） | `agent.ts:150` | 以行首 markdown 标题的"## 最终结论"为唯一收尾判据 | 裸"最终结论"会被计划项"3.给最终结论"误命中→半途误判已收尾 | — |
| 终极收尾安全网 | `agent.ts:884` | 读过代码却想 clean done 又没写结论时，用 ledger 草稿逼一次完整收尾 | 堵"追对了但陈述句结尾、直接 done、链路图没画" | — |
| nudge 连续空转计数 | `agent.ts:913` | nudge 配额改成"连续空转计数"，这轮真发工具就清零 | 固定配额难任务多轮耗尽后放行 done；话痨但有进展的不该被掐死 | — |
| ctxCeiling 硬止损 | `agent.ts:785` | 真实 ctx 超 `ctxCeiling(120k)` 或 budget red，超 maxRedSteps 仍不收敛就强制收尾 | nudge 只在自愿停手时生效，有模型超限仍狂调工具 | `ctxCeiling/maxRedSteps` |
| forcedFinish 硬执行 | `agent.ts:927` | 进入强制收尾后模型再要工具一律拒执行，超 maxForcedSteps 步硬终止 | 劝告式收尾只对听话模型有效；35B 无视"停止探索"撞墙钟 | `maxForcedSteps`（默认 2） |

## 🏗️ 框架化（MVP-0..4，把决策/流程/知识移进框架）

| 机制 | 位置 | 做什么 | 治什么 | 开关 |
|---|---|---|---|---|
| 单步 Plan-Act 手动 dispatch | `agent.ts:622` | 每轮只跑一次 LLM 拿 tool_calls，手动 classify→approve→run（tool 定义故意不放 execute） | 强制每个工具调用都走审批+去重管道，不让 SDK 绕过守卫 | — |
| decideGuard 纯函数（signal/count） | `guards.ts:88` | 离线可单测：signal 模式资源硬上限才 finish，打转注入 CHECKPOINT+给预算 | count-gated 守卫双刃剑（reads=0 就 forced-finish 逼出浅答） | `REV_GUARD_MODE=count`（回退，**默认 signal**） |
| CHECKPOINT 注入 | `guards.ts:64` | reads=0 注入"停 grep 去 read 方法体"；reads>0 停滞注入"精读那一个/写结论"并重置计数给预算 | 把"计数触发强制收尾"改成"信号触发注入明确下一步"，保留深调查 | —（signal 默认） |
| MAX_CHECKPOINTS 宽限+资源标注 | `guards.ts:49` | 每 trigger 最多注入 2 次，收尾明确标"资源上限而非任务完成" | 宽限内给足探索；收尾诚实区分"已证实 vs 因资源未证实"防幻觉 | — |
| 卡住求助 escalate/halt | `agent.ts:533` | 卡住构造困境报告→askStrategy 取思路→注入重置续跑；无思路则 halt(exit=3) 或回退 | 原地打转不再一律"强制猜答案"，向人/更强模型求思路 | `--ask-when-stuck`/`--consult-cloud` |
| 栈感知 playbook 注入（只作 context） | `playbook.ts:125` + `run-once.ts:258` | 按 stack-probe 命中栈+关键词把 how-to 套路拼首条消息末尾，明标"可无视" | 系统主动推程序性知识解"弱模型不会自查知识库"悖论 | `REV_PLAYBOOK=1`（**默认关**，多 seed 证注入轻度净负，见 [[Comparisons]]④） |
| playbook 从 ledger 自动生长 | `playbook.ts:153` | 从一次真解出的 ledger 轨迹归纳 learned playbook 持久化，下次同栈注入 | bitter-lesson：优先自动生长，手写 seed 仅冷启动 | `REV_PLAYBOOK=1` |

## 📜 协议注入（开局前置，把用户协议+确定性事实塞进 context）

| 机制 | 位置 | 做什么 | 治什么 | 开关 |
|---|---|---|---|---|
| system §切片 + §9 避坑块 | `prompts.ts:45` | 从协议 MD 抽 §1短/§2长/§3续传，自动把 §9 通用避坑块追加到末尾 | 把用户手写 4 阶段协议+7 铁律强制作 system；§9 消高频失败模式 | `--verbose/--resume`；`REV_AGENT_PROMPT_PATH` |
| 主动栈探测（防谎称无 native） | `stack-probe.ts:190` | 开局定位原始 APK→`unzip -l` 看 lib/assets 签名→按指纹识别 Unity/Flutter/RN/加固，注入首条消息 | Round-3 头号失败=栈识别 false-negative（谎称无 libil2cpp 实则 29MB 在） | —（源码级/审计意图自动触发） |
| 栈探测 dataGap 诚实模式 | `stack-probe.ts:194` | 定位不到 APK 时报告转"看不到 lib 无法判栈，切勿据没看到断言无 native" | 从源头掐掉 false-negative | — |
| 案卷续分析 --corpus | `corpus.ts:102` + `run-once.ts:108` | 秒扫强 agent 前置产物（MD/trace/pcap/dump/源码树）产 manifest，注入案卷协议 | 适配"接手别人前置分析续查"而非从裸 APK 从零逆向 | `--corpus` |
| 案卷协议：出处分级+三角验证 | `corpus.ts:211` | 每条结论标来源（[前人MD]/[代码]/[trace]/[推断]），承重结论拿一手证据，两源互证 | 混二手结论与一手证据往下推是本模式最大坑 | `--corpus` |
| 锚点自检（防错锚点传染） | `corpus.ts:232` | 案卷每个 file:line 锚点 read 后逐字核对，不符标"案卷此处有误"自己重定位 | 照抄一个错锚点会传染成自己的错结论 | `--corpus` |
| 案卷 INDEX handoff 草稿 | `corpus.ts:244` | 无 INDEX 时收尾产出交接草稿（已知结论+证据+开放问题） | 多 agent 协作 handoff 契约 | `--corpus` |
| 笔记续传 --resume | `resume.ts:49` | 读上一会话笔记全文注入+抽 §4 下一步，用 §3 续传 prompt 接着干 | 跨会话续传省再 read 笔记；缺失明确报错不静默退化 | `--resume`/`--notes` |
| 源码级 preflight fail-fast | `preflight.ts:102` | 缺完整源码树时秒退(码2)+给 jadx/apktool 配方 | 整包 jadx 反编 ~123s>60s 硬超时，LLM 零增值 | —（仅源码级意图无源码树时拦） |

## 🔐 安全（只读红线 + 出网脱敏防火墙，默认不出网）

| 机制 | 位置 | 做什么 | 治什么 | 开关 |
|---|---|---|---|---|
| 工具 classify auto/ask/deny + Zod | `tools/index.ts:71` | 先 Zod safeParse（失败→deny），再分级；不放 execute 强制主循环手动 dispatch | 统一审批闸门 | — |
| shell 白名单+黑名单+写审批+超时+截断 | `tools/shell.ts:135` | 首 token 必在白名单，rm/sudo/curl→deny，cp/mv/sed-i/apktool b→ask，5s 超时，各截 4KB | 守"只读分析"（sed -i 曾漏判能盲改 smali）；防危险命令+防输出淹没 | `timeoutMs` |
| read_file 强制 ≤200 行 | `tools/read-file.ts:9` | Zod 把单次读行数硬上限编进 schema，自动加行号 | 铁律2编进 schema，防单次读爆上下文 | — |
| grep ≤50 命中 + 健壮 rg 解析 | `tools/grep.ts:136` | maxHits 50；遍历 PATH `--version` 验真 rg（跳 shell function 假路径），退回 grep -E | `which rg` 命中 Claude Code 注入的 rg() function→静默退回 BSD grep 让 `\|` 交替失效 | — |
| append_note 恒 ask | `tools/note.ts:107` | 唯一写工具，classify 永远 ask 弹审批 | 写盘操作必须人点头 | `--notes` |
| 云端顾问（方法论-only） | `advisor.ts:81` | 卡住把脱敏困境报告发云端，只回"下一步怎么查"，还原后注入续跑，任何失败干净回退 null | 云端是获取思路的途径不是主执行器；与本地 lemonade 串行不并发 | `--consult-cloud`（默认关，与 --ask-when-stuck 互斥） |
| 脱敏防火墙（台账精确替换） | `redact.ts:213` | 以台账 verbatim 标识符做确定性可逆替换（同真值恒同占位符，长优先防子串误伤） | 不靠不可靠 NER，用已知事实做高精度可逆脱敏 | `--redact-level 0/1/2` |
| 正则兜底脱敏 | `redact.ts:108` | catch 台账外内嵌敏感：URL/email/绝对路径/高熵key(Shannon熵过滤)/IP/包名/资源名 | 台账清单外的嵌入式 PII 也要脱 | `--redact-level` |
| fail-closed 泄露扫描 | `redact.ts:272` | 脱敏后再跑检测器，命中即 leaks[]；顾问见非空默认中止出境返回 null | 脱敏不完全时宁可不出境也不泄露 | — |
| 占位符还原多层容错 | `redact.ts:301` | 把云端返回占位符换回真值，覆盖 `<CLS_1>`/`< CLS_1 >`/复合伪占位符/裸id，长id先替 | 云端（minimax）会各种改写占位符，需健壮还原 | — |
| 出境门 + 不落盘 + 事件透明 | `advisor.ts:120` | 出网前经 onEgress 钩子（可人工拒），RedactionMap 只在内存不落盘，onEvent 打印脱敏面/成败 | 出网内容对用户透明可审计；落盘=再识别密钥 | `--consult-cloud` |

## ⚙️ 后端 & 健壮性（本地大模型友好）

| 机制 | 位置 | 做什么 | 治什么 | 开关 |
|---|---|---|---|---|
| reasoning_content 改写 fetch + 中间件 | `llm.ts:19` | custom fetch 拦 SSE 把非标 `delta.reasoning_content` 改写成内联 `<think>`，配 extractReasoning 拆回标准 part | 本地端点把思考链放非标字段，@ai-sdk/openai 不认→整段 reasoning 被静默丢弃 | —（本地 backend 自动包） |
| 跨 chunk 行缓冲 | `llm.ts:59` | 缓冲未完成行只处理完整行，流末 flush+补悬空 `</think>` | chunk 边界不保证落换行，直接 split 会半行 JSON.parse 失败 | — |
| 多后端切换 | `llm.ts:143` | 支持 7 后端，本地端点强制走 chat completions（非 v6 默认 Responses API） | 本地服务一般不支持 Responses API | `--backend/--model/--base-url` |
| streamText 流式增量 | `agent.ts:332` | fullStream 实时 emit text/reasoning delta，UI 边收边上屏 | 治 Qwen 长推理期 generateText 死屏 | — |
| 两段式超时（首token 300s/空闲 120s） | `agent.ts:307` | 首 token 前用宽超时，收到首字切紧的空闲超时，每 part 续期 | 本地 35B 大 prefill+长 CoT 几分钟才吐首字，统一超时会误判 stall | `firstTokenTimeoutMs/stepTimeoutMs` |
| 可重试错误指数退避 | `agent.ts:111` | 网络/5xx/超时/abort 按 1/2/4s 退避重试 | 本地后端抖动不该让整轮崩 | `maxLlmRetries`（默认 2） |
| Zod 校验失败喂回重试 | `agent.ts:61` | tool args 校验失败把错误喂回模型让它修 | 小模型常给不合 schema 参数 | `maxRetries`（默认 2） |
| 组件埋点 SCORECARD | `agent.ts:416` | 收尾 emit 含 steps/cache/ctx/folded/dedup/checkpoints/guard/forced 的记分卡 | 让 harness 逐组件有理有据打分 | — |
| 每轮计数器重置 | `agent.ts:275` | 交互模式每次新消息前重置 stepCount/nudge/redSteps（ledger 会话级不重置） | 否则跨轮累加跑满 maxSteps 后会话卡死 | — |
| 有界递归源码树识别 | `preflight.ts:38` | 查 sources/smali 或限深 6 层递归找 .java/.smali/.dex | 只查一层会误杀正常包嵌套 com/vendor/module/X.java | — |

---

> 共约 **60 个机制**。绝大多数是"治某个实测失败模式"的针对性补丁——每一条的 `治什么` 都对应一次真实翻车（benchmark 编号/App 名）。这也是为什么框架比"裸提示驱动模型"稳得多。
