# Goal 模式预算机制重设计（对齐 ZCode）

状态：草案，待评审
日期：2026-11-27
范围：`src/agent-host/goal-mode.ts`、`goal-state.ts`、`rpc-manager.ts`、渲染端与移动端 goal 面板

## 1. 问题

当前 goal 模式用 **turn 计数**（默认 8，`DEFAULT_MAX_CONTINUATIONS`）做自动续跑预算，撞线即停（`budget_exhausted`），等用户手动点「追加预算」。

turn 是个劣质工作量单位：

- **粒度失控**：一轮可以是 3 分钟也可以是 6 小时，`8/8` 既不约束成本（token/钱）、不约束时间，也不约束任何用户能感知的量。
- **常态误伤**：这个预算的本意是无人值守安全阀（防死循环烧钱），但实现成了常态机制——正常的长任务也会在第 9 个 turn 被硬停在半截，然后烧掉一轮让模型「总结并停下」。
- **停止代价高**：`budget_exhausted` 分支要写两条会话条目 + 一轮只输出总结的 LLM 调用，纯粹为了告诉模型「别干了」。

对照 ZCode 的做法：**不存在续跑计数**。turn 语义就是「一次用户交互」，长任务靠单 turn 不结束 + 自动 compaction 跨窗口续命；欠的活用 todo 台账表达，不占用 turn；真正无人值守的持续工作是独立的调度机制（cron / 闲时任务），不在对话流里内嵌预算截断。

## 2. 设计目标

1. 正常工作流永不因「跑得久」而中断——只因任务完成或需要用户决策而停。
2. 无人值守安全性仍有兜底：失控重复行为要能熔断。
3. 停止时机可解释、用户可感知（花了多少钱/多少 token，而不是几个 turn）。
4. 状态从会话分支重建（现状不变量，必须保留）：重开 app、切分支、compaction 后预算仍在。
5. 渲染端（桌面 + 移动）展示口径同步换掉。

## 3. 方案：token 预算 + 循环熔断，删除 turn 预算

### 3.1 核心变更

| | 现在 | 改成 |
|---|---|---|
| 预算单位 | turn 数（8，强制） | 累计 token 消耗（**可选**，留空不限制） |
| 超限行为 | 强停 + 等用户 | 同左，但阈值是真实成本；无预算时不触发 |
| 循环检测 | 无 | 连续 N 轮 todo 无推进 / 相同工具重复调用 → 熔断 |
| checkpoint | 每 4 轮 | 预算的 25% 里程碑处；无预算时退化为不 checkpoint |
| `budget_exhausted` | turn 撞线 | token 撞线 |

### 3.2 数据来源（pi 扩展 API 已具备）

- **token 用量**：`Usage`（pi-ai，input/output/cacheRead/cacheWrite/totalTokens + cost）挂在 `ToolResultEvent.usage`、assistant 消息上。`turn_end` 处累计写入自定义条目。
- **上下文余量**：`ctx.getContextUsage()`（tokens / contextWindow / percent）。
- **compaction**：goal 的 prompt 块设计为扛 compaction（现状已如此），不做额外干预；上下文接近满时 pi 自身的 auto-compaction 继续接管，与 goal 无关。

### 3.3 会话条目（保持「分支即真相」不变量）

```ts
// goal-state.ts —— GoalEntry 追加字段
| { kind: "start"; goal; criteria; budgetTokens?: number; checkpointEvery: number }  // maxContinuations 字段删除
| { kind: "continue"; tokens?: number }   // ← 记录该次续跑的 token 增量
```

- `continuations` 计数保留（纯展示用，告诉用户「这是第几次自动续跑」），**不再参与任何决策**。
- 状态重建逻辑照旧从 `start` 往后数，只是把 `continue` 条目上的 `tokens` 累加得到 `tokensUsed`。
- 存量会话里 `start` 没有 `budgetTokens` → 读作「无预算」（不熔断），向前兼容。

### 3.4 决策逻辑（goal-mode.ts `decideGoalTurnEnd` 改写）

```
turn_end & completed & status == working:
  1. 有预算 且 tokensUsed >= budgetTokens → budget_exhausted（真实成本撞线）
  2. 循环检测触发                     → budget_exhausted，条目 kind: "loop_detected"
  3. 否则                            → 追加 continue 条目（带 tokens 增量），续跑
```

checkpoint：有预算时按 `tokensUsed / budgetTokens` 的 25% / 50% / 75% 里程碑触发；无预算时不 checkpoint（替换现在的每 4 轮）。

### 3.5 循环熔断（新能力，安全阀的本体）

预算可选之后，「无人值守失控」的唯一兜底就是这里，不能也是可选：

- 信号 A：连续 `LOOP_STALL_TURNS` 个续跑 turn 结束时，todo 计划的已完成项数量未增加。**默认 3，硬编码**（安全阈不该让用户配大配没）。
- 信号 B：同一工具+同参数指纹连续命中 ≥ M 次（指纹=toolName+args 的 hash，滑动窗口去重）。M 默认 5，同样硬编码。
- 命中任一信号 → 熔断并写入 `loop_detected` 条目，UI 状态与 `budget_exhausted` 同路径展示（文案区分：「疑似原地打转」）。
- 两个信号都从会话条目可重建（todo 快照 + 工具调用记录本来就在分支里）。

### 3.6 预算：可选，默认不限制

**无 `DEFAULT_BUDGET_TOKENS` 常量**——预算完全由用户按需指定：

- `/goal` 启动时弹出的 acceptance criteria 对话框里带一个**可选的预算输入**（token 数，留空 = 不限制）。
- 留空（默认路径）：**无 token 预算、不熔断成本**，与 ZCode 对齐——只在「无预算」下跑，失控保护完全交给循环熔断。
- 填了：按 token 撞线熔断，checkpoint 按预算里程碑走；`extend` 的 `EXTEND_STEP` 同步换成 token 步进。

也就是说：常态 = 无限制（用户在场看得到）；无人值守长跑 = 用户自己填一个数。安全阀从「默认强加」变成「按需挂上」。

### 3.7 UI（桌面 + 移动同步改）

- 面板主指标从 `{used}/{max} 次自动续跑` 换成 **token/成本**：`预算 ¥X / 已花 ¥Y`；**无预算时只显示「已花 ¥Y / 第 N 次续跑」**，不显示上限行。
- `budget_exhausted` 文案区分 token 撞线 vs 循环熔断。
- `追加预算` 按钮保留，步进值换成 token 步进。
- i18n 三语同步（en-US / zh-CN / zh-TW）。

## 4. 为什么不是别的方案

- **纯 ZCode 式「无预算」**：ZCode 是交互式 harness，用户在场盯着；goal 模式的核心场景恰是无人值守长跑，一个数字兜底是必要的。方向是「兜底约束真实成本」，不是「取消兜底」。
- **时间预算**：需要持久化计时器、暂停/恢复语义，且 LLM 任务 5 分钟和 5 小时都是合法的，时间同样不约束成本。
- **工具调用次数**：比 turn 好，但一次 `bash` 和一次 `browser` 成本差 3 个量级，仍然不是成本度量。

## 5. 分阶段落地

1. **P0（纯后端，无 UI 变更）**：条目带 tokens、`decideGoalTurnEnd` 改 token 判定（无预算 = 永不撞线）、旧会话兼容读。面板数字暂保持 turn 计数展示。
2. **P1**：循环熔断两个信号 + `loop_detected` 状态（无预算路径的唯一兜底，优先级最高）。
3. **P2**：UI 换口径（桌面 + 移动）+ i18n + `/goal` 启动对话框加可选预算输入（留空不限制）。
4. 每阶段独立可回滚：条目是增量字段，回滚只是「读不到新字段→走旧逻辑」。

## 6. 风险

- **无预算 + 熔断失灵的敞口**：预算留空时，若循环检测的两个信号都没命中（例如模型每次都微调参数、todo 也零星推进，但实际在绕圈），成本无上限。这是「默认无限制」的固有代价，接受它——用户在场看得到进度，真烧钱了打回/停止都是一次点击。
- **token 统计口径**：cacheRead/Write 权重和 cost 折算因 provider 而异，展示端要标注「估算」。`Usage.cost` 若 provider 未填，退化为 `totalTokens`。
- **循环误报**：todo 无推进≠没干活（可能在调研阶段）。`LOOP_STALL_TURNS` 容忍 3 轮 + 误报时代价只是一次用户确认，可接受。预算留空的用户依赖这个熔断兜底，所以两个阈值都硬编码，不暴露成设置项——配置项会被调大，安全阀就不安全了。
- **移动端协议**：`goal_state` 事件结构加字段（`tokensUsed`/`budgetTokens`），旧手机 app 读到未知字段会忽略——`packages/protocol` 的 allowlist 需要同步。
