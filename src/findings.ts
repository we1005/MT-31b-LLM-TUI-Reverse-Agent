/**
 * 顺路发现缓存（最小版·被批准路径）——把工作笔记尾部（最近 append_note 记下的顺路发现）
 * 格式化成一段「未核验线索」块，供 agent 跨折叠/跨续传复用之前顺路看到的 key/端点/native 跳转等。
 *
 * 设计铁律（docs-resources/顺路发现缓存-旁路语义记忆-深度分析.md + memory findings_cache_verdict）：
 * - **零正则解析、零新数据结构**：只做「取尾部 + 对齐块边界 + 包一层低优先级说明」，不做任何 findings 抽取引擎
 *   （混淆 APK 上正则非噪即哑，且以系统权威口吻注入未核验猜测会撞反幻觉红线）。
 * - **只作最低优先级 context**：措辞明确「未核验、可能过时、用前必重读 file:line 亲自核对」，绝不当权威事实。
 * - **SWA**：调用方必须把它拼到 messages **末尾** ephemeral，绝不进 system 头部（见 swa_stable_prefix）。
 */
export function renderFindingsBlock(notesText: string, budgetChars = 4000): string {
  const body = (notesText ?? '').trimEnd();
  if (!body) return '';
  let tail = body.length > budgetChars ? body.slice(-budgetChars) : body;
  // 若发生截断，对齐到下一个 note 块起始（"## "），避免把半截块喂给模型误导。
  if (body.length > budgetChars) {
    const i = tail.indexOf('\n## ');
    if (i >= 0) tail = tail.slice(i + 1);
  }
  const shown = tail.trim();
  if (!shown) return '';
  return (
    '【顺路线索·未核验（优先级最低，可无视）——下面是你或前人之前用 append_note 记下的顺路发现，' +
    '可能过时、也可能只是猜测；要用其中任何 file:line / 标识符前，先重读该处亲自核对，' +
    '绝不照抄未核验的锚点当结论】\n' +
    shown
  );
}
