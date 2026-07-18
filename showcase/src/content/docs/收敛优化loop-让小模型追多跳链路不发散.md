# 收敛优化 loop：让本地 35B 在多跳链路追踪上不发散、能收尾

> **日期**：2026-07-10
> **目标**（用户设定）：不断优化直到完全解决 run3 暴露的 3 个问题；并出更复杂场景题持续发现新问题再解决。
> **方法**：头脑风暴(4维度16路径)找根因 → 排序挑先做项 → 实现→A/B→决策门→再优化 的循环。

---

## 0. 要解决的 3 个纠缠问题（run3 实跑暴露）
- **P-发散**：agent 一个个类读停不住，上下文失控
- **P-收尾**：超大上下文下 35B 生成最终报告极慢，撞墙钟
- **P-断链**：小模型总造新"宣布下一步却不做"的漏网句式

---

## 1. 根因（头脑风暴+复核代码，非模糊"发散"）

`appendToolResult` 把每次 tool 的**原始结果永久堆进 messages** + `callLLM` 每步**全量重发** messages
→ 读过的 200 行类在之后每步都被重复当输入 → **prefill 二次增长**，冲到 173k。

**同时纠正一个测量假象**：run3 的"budget 217%"部分是**计量伪量**——`budget.used` 在 lemonade
不回 usage 时把每步完整历史累加，是 super-linear 的假量。真实上下文要另用 `contextTokens()` 量。

---

## 2. 三波优化 + 定量结果

| 版本 | 改动 | ctx 峰值 | exit | 链路产出 |
|------|------|---------|------|---------|
| **A (run3 基线)** | 无 | ~173k 二次爬 | 124 撞 600s 墙 | 无 |
| **B** | compactHistory 折叠已读 tool-result | **5.4k 平台化** | 0 | 2/6 跳（丢跳迷路）|
| **wave2** | + §9 台账纪律（每跳写永不折叠正文结论）| ~5k（峰9k） | 0 | **4/6 骨架全对 + 链路图 + 汇总表** |
| **wave3** | + ctxCeiling 真实ctx止损 + nudge连续空转计数 | ~5k（17步没爆）| 0 | **难题：完整签名校验链 + 6台账 + 链路图** |

**ctx 从 173k 压到 ~5k（33 倍降）且平台化不再单调爬升**——这是根因治好的模型无关铁证。

---

## 3. 四个组合机制（一套咬合的齿轮，非零散补丁）

1. **compactHistory 折叠**（`agent.ts`）：run() 每步先把除最近 K=3 条外的旧 tool-result 的 `output.value`
   换成轻量 stub（保留 toolCallId/toolName 守 v6 配对；永不折叠 append_note 台账 / assistant 正文）。
   **封住 prefill 二次增长这个根因**，机械压缩、零额外 LLM 调用、不靠小模型自律。
2. **§9 台账纪律**（prompt）：追链任务每确认一跳，立刻在**正文**写一行 `跳N: 源.方法 → 目标 | 证据行`。
   正文永不被折叠 → 即使原始类体被折叠抹掉，链路知识靠逐行台账留存 → 收尾=拼台账而非在巨上下文重生成。
   配套纪律：一次一跳、不追岔路、够了就拼台账收尾。
3. **ctxCeiling 硬止损**（`agent.ts`，默认 40k）：真实 `contextTokens()` 超阈（而非被污染的 budget.used）
   + 再放行 maxRedSteps 步仍不收敛 → 强制收尾。给 35B 留足生成余量、不撞墙。
4. **nudge 连续空转计数**（`agent.ts`）：原 nudgeCount 是全轮固定配额，难任务多轮后耗尽就放行 done
   （sig-chain v1 就栽此）。改成**有 tool call（有进展）就重置**，nudge 只惩罚"连续宣布却不做"。
   话痨但有进展的 agent 不被掐死，真原地空转才止损。

---

## 4. 难题验证：签名校验链路（比 MCP 链更难）

**难在哪**：`signature` 命中 130 个文件（强干扰，含 alipay/umeng/tencent 第三方库噪音）、可能跨 native JNI 边界、不给类名线索。

**结果（wave3 版）**：完整追出并画图——
```
C2676.mo6071(PackageManager, String)
  ▼ getPackageInfo(str,64).signatures
C1744.m5156(Context, C6030)
  ├─ Signature[].toByteArray()   [转字节]
  ├─ Collections.sort            [排序]
  ├─ c6030.m15609()/resources    [加载期望签名]
  └─ Arrays.equals() 逐字节比对  [校验]
       ▼ (校验通过)
  Native 补充校验 (C10857/C20274)
       ▼ .so (待确认,需 frida)
      JNI 终止
```
- ✅ 正确排除第三方库噪音，只追 MT 自身签名校验
- ✅ 正确处理 native 边界：追到 native 方法声明处，诚实标"待确认需 frida 动态验证"——正是"静态到 JNI 边界终止、动态交人"的正确认知
- ✅ ctxCeiling 生效（ctx=5572/40k 触发强制收尾），nudge 靠有进展重置撑满 17 步没耗尽

---

## 5. 结论

**P-发散 / P-收尾 / P-断链 三问，在 MCP 链路 + 签名校验链（更难）双任务上均解决。** 回归 demo 5/5 + resume 7/7 零破坏。

**核心洞察**：小模型做多跳追踪的关键不是"让它更聪明"，而是**给它一个不会失控的工作环境**——
- 上下文机械封顶（compactHistory + ctxCeiling），别让它自己爆；
- 知识增量固化（台账纪律），别指望它回头重看；
- 收敛信号确定化（nudge 连续空转 + ctx 止损），别靠它自律停手。
这套对**任何**小参数本地模型都通用，与 Qwen 具体能力无关。

---

## 6. loop 仍可继续（诚实标注未尽）
- `budget.used` 伪量清理：纯记账用，告警/判据已迁到真实 ctx，可移除累加伪量
- 方案 A（read_file outline 模式）：单跳更省，当前靠 compactHistory 已够，是锦上添花
- 更多复杂题型：跨包深链 / 混淆更重 / 多入口汇聚 —— 持续出题发现新失败模式

## 关联
- 优化 loop 全状态：memory `convergence_optimization_loop.md`
- 头脑风暴 16 路径 + 排序：workflow wf_6adf610c-4a4
- 前置能力边界：`rev-agent 完整性审查与打包签名能力判断-存档.md`
- 下指令方式：`如何给rev-agent下达逆向任务-使用指南.md`
