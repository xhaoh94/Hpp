# 内置模型能力管理 & 聊天框思考档位显示规则

## Summary

重构多 Agent 项目中模型能力的显示与配置规则：

1. **模型配置弹窗**（AgentConfigModal）：当配置的模型在 Agent 内置目录中存在（Agent 可获取其思考等级/图片能力）时，隐藏「图片」「思考」「思考档位」三个控件，能力由 Agent 管理；非内置（自定义）模型才显示这些控件供用户配置。
2. **聊天框思考档位选择器**（ChatToolbar / Mobile）：内置模型按 Agent 获取到的数据决定显示下拉还是开关（已有逻辑，保留）；非内置模型按自定义勾选的思考等级决定——只勾选 1 个等级时显示开关，多个等级显示下拉。

## Current State Analysis

### 模型配置弹窗现状
- [AgentConfigModal.tsx#L1420-L1448](file:///c:/Project/Hpp/src/components/sidebar/AgentConfigModal.tsx#L1420) 模型行渲染：图片 checkbox（`disabled={fixedModelCapabilities}`）、思考 checkbox（始终可编辑）、思考档位多选（`model.hasThinkingLevels` 控制显示）。
- 只有 **pi** 的 [config.mjs#L196-L225](file:///c:/Project/Hpp/electron/agent-plugins/pi/config.mjs#L196) `normalizeModel` 计算 `hasThinkingLevels`，基于 `directoryEntry`（内置目录条目）判断。
- codex / claude 的 `fixedModelCapabilities: true` 只禁用图片 checkbox，思考 checkbox 仍可编辑。
- 没有统一的「该模型是否内置」信号字段。

### 聊天框思考档位现状
- [worker.mjs#L1271-L1273](file:///c:/Project/Hpp/electron/plugin-backends/pi/worker.mjs#L1271) pi worker 计算 `thinkingLevelMode`：`hasDeclaredLevels ? "levels" : "toggle"`。
- 只有 pi worker 产出 `thinkingLevelMode`；codex/droid/opencode/claude 后端均不产出，`combineAgentModels` 也不补。
- [ChatToolbar.tsx#L288](file:///c:/Project/Hpp/src/components/layout/ChatToolbar.tsx#L288) 条件：`currentModel?.reasoning && currentThinking && thinkingLevels.length > 0 && (thinkingLevelMode === "toggle" ? 开关 : 下拉)`。当 `thinkingLevelMode` 为 undefined（非 pi）时走下拉分支。
- 非内置模型若只勾选 1 个等级，当前会显示「只含 1 项的下拉」，不符合「显示为开关」的期望。

### 关键数据流
- pi 内置检测信号：`directoryEntry`（[config.mjs#L203](file:///c:/Project/Hpp/electron/agent-plugins/pi/config.mjs#L203) `getDirectoryModelEntry`），仅 pi 可用。
- 配置弹窗数据：`readProviderConfig` → `listAgentConfig`（`enrichWithDiscoveredThinkingLevels` 补全）→ 弹窗 draft → `handleSave` → `toProviderConfig` 写回 models.json。
- 聊天框数据：`getConfiguredAgentModels` → `combineAgentModels`（配置覆盖后端）→ `useSessionModels` → ChatToolbar。
- `combineAgentModels` 的 `{ ...backend, ...model }` 让配置值覆盖后端值，所以内置模型若配置了错误能力会覆盖后端正确值。

## Proposed Changes

### Part A：模型配置弹窗——内置模型隐藏能力控件

#### A1. 类型定义 — 新增 `isBuiltin` 字段
- [src/types/index.ts#L117-L126](file:///c:/Project/Hpp/src/types/index.ts#L117) `AgentCustomModelConfig`：新增 `isBuiltin?: boolean`（该模型是否在 Agent 内置目录中，能力由 Agent 管理）。
- [electron/agents/agent-config.ts#L10-L21](file:///c:/Project/Hpp/electron/agents/agent-config.ts#L10) `AgentCustomModelConfig` 接口：同步新增 `isBuiltin?: boolean`。

#### A2. pi config.mjs — 标记内置模型 & 读取目录权威能力
- [config.mjs#L196-L225](file:///c:/Project/Hpp/electron/agent-plugins/pi/config.mjs#L196) `normalizeModel`：
  - 新增 `isBuiltin: !!directoryEntry`。
  - 内置模型（`directoryEntry` 存在）时，`reasoning`/`imageInput` 优先从目录条目读取（目录条目有该字段时为权威值，避免 models.json 中的陈旧值覆盖后端）；目录条目无该字段时回退到 models.json 值。
  - `hasThinkingLevels` 改为 `!isBuiltin`（内置模型一律 false，不显示思考档位多选）。

#### A3. agent-config.ts — 保留 & 补全 `isBuiltin`
- [agent-config.ts#L95-L111](file:///c:/Project/Hpp/electron/agents/agent-config.ts#L95) `normalizeModel`：新增 `...(value.isBuiltin === true ? { isBuiltin: true } : {})`。
- [agent-config.ts#L250-L296](file:///c:/Project/Hpp/electron/agents/agent-config.ts#L250) `enrichWithDiscoveredThinkingLevels`：
  - 用发现结果补全 `isBuiltin`：`merged.isBuiltin = discoveredModel.isBuiltin === true`。
  - 内置模型 `hasThinkingLevels` 设为 false（覆盖旧版保存的 true 残留）。

#### A4. AgentConfigModal.tsx — 隐藏控件 & 保存逻辑
- [AgentConfigModal.tsx#L1420-L1448](file:///c:/Project/Hpp/src/components/sidebar/AgentConfigModal.tsx#L1420) 模型行：
  - 引入 `const capabilitiesManaged = model.isBuiltin || providerConfiguration?.fixedModelCapabilities === true;`
  - 图片 checkbox：`capabilitiesManaged` 时不渲染（隐藏，替代当前的 `disabled`）。
  - 思考 checkbox：`capabilitiesManaged` 时不渲染。
  - 思考档位多选：`!capabilitiesManaged` 时才渲染（替代 `model.hasThinkingLevels`）。
- [AgentConfigModal.tsx#L749-L772](file:///c:/Project/Hpp/src/components/sidebar/AgentConfigModal.tsx#L749) `handleSave`：
  - `capabilitiesManaged` 时清空 `supportedThinkingLevels`（`undefined`，不写入自定义档位，让目录/默认提供）。
  - `isBuiltin` 时保留 draft 的 `reasoning`/`imageInput`（来自目录，已在 normalizeModel 中设为权威值）。
  - `fixedModelCapabilities` 时从 `providerConfiguration.modelDefaults` 取 `reasoning`/`imageInput`（已有 imageInput 逻辑，扩展到 reasoning）。
- [AgentConfigModal.tsx#L23-L35](file:///c:/Project/Hpp/src/components/sidebar/AgentConfigModal.tsx#L23) `emptyModel`：新增 `isBuiltin: false`。
- [AgentConfigModal.tsx#L720-L732](file:///c:/Project/Hpp/src/components/sidebar/AgentConfigModal.tsx#L720) picker `additions`：新增 `isBuiltin: false`。

#### A5. 测试更新
- [config-providers.test.ts#L182-L188](file:///c:/Project/Hpp/electron/agent-plugins/config-providers.test.ts#L182)：pi 内置模型期望 `isBuiltin: true`、`hasThinkingLevels: false`；`reasoning`/`imageInput` 来自目录（deepseek: reasoning true, imageInput false）；非内置模型 `isBuiltin: false`、`hasThinkingLevels: true`。
- [agent-config.test.ts#L181-L225](file:///c:/Project/Hpp/electron/agents/agent-config.test.ts#L181) enrich 测试：内置 deepseek 期望 `isBuiltin: true`、`hasThinkingLevels: false`。

---

### Part B：聊天框思考档位——非内置模型按等级数量决定开关/下拉

#### B1. pi worker — 1 个等级也显示开关
- [worker.mjs#L1271-L1273](file:///c:/Project/Hpp/electron/plugin-backends/pi/worker.mjs#L1271) `getModels` 中 `thinkingLevelMode`：
  - 改为 `"levels"` 仅当 `hasDeclaredLevels && levels.filter(l => l !== "off").length > 1`；否则 `"toggle"`。
  - 效果：内置模型 deepseek（2 档）→ levels ✓；mimo（无声明）→ toggle ✓；自定义模型只勾 1 档 → toggle（新增行为）。

#### B2. shared/models.ts — 新增前端推导 helper
- [shared/models.ts](file:///c:/Project/Hpp/shared/models.ts) 新增 `getEffectiveThinkingLevelMode(model)`：
  ```ts
  export function getEffectiveThinkingLevelMode(
    model?: Pick<SharedModel, "reasoning" | "thinkingLevelMode" | "supportedThinkingLevels"> | null,
  ): "levels" | "toggle" | undefined {
    if (!model?.reasoning) return undefined;
    if (model.thinkingLevelMode) return model.thinkingLevelMode;
    // 非 pi 后端未产出 thinkingLevelMode：按自定义等级数量推导
    const levels = normalizeSupportedThinkingLevels(model.supportedThinkingLevels).filter((l) => l !== "off");
    return levels.length > 1 ? "levels" : "toggle";
  }
  ```
  - pi 模型：worker 已设 `thinkingLevelMode` → 直接使用。
  - 非 pi（droid/opencode/codex/claude）：`thinkingLevelMode` undefined → 按等级数量推导（0 或 1 档 → toggle，>1 档 → levels）。

#### B3. ChatToolbar.tsx — 使用推导模式
- [ChatToolbar.tsx#L288](file:///c:/Project/Hpp/src/components/layout/ChatToolbar.tsx#L288)：
  - 用 `const effectiveMode = getEffectiveThinkingLevelMode(currentModel);` 替代直接读 `currentModel.thinkingLevelMode`。
  - 外层条件改为 `currentModel?.reasoning && effectiveMode &&`（移除 `currentThinking && thinkingLevels.length > 0` 的硬性要求，让 toggle 模式在无等级时也能显示）。
  - toggle 分支不依赖 `thinkingLevels`（用 "medium"/"off" 切换，已有逻辑）。
  - dropdown 分支保留 `thinkingLevels.map(...)`，若为空则不渲染选项（安全降级）。

#### B4. mobile App.tsx — 同步推导
- [mobile/src/App.tsx#L4947](file:///c:/Project/Hpp/mobile/src/App.tsx#L4947) `MobileThinkingPicker` 的 `mode`：
  - 改为 `mode={getEffectiveThinkingLevelMode(selectedConfig?.model)}`。
  - 确认 `MobileThinkingPicker` 在 `mode="toggle"` 且 `levels` 为空时能正常渲染开关（读取组件实现确认）。

#### B5. 测试更新 & 新增
- [worker.test.ts](file:///c:/Project/Hpp/electron/plugin-backends/pi/worker.test.ts)：现有 3 个测试（pi-model→toggle、gpt-5.6-luna→levels、deepseek→levels）均不受影响（均 >1 档或无声明）。新增 1 个测试：自定义模型 thinkingLevelMap 只声明 1 个非 off 档（如 `{ medium: "medium" }`）→ `thinkingLevelMode: "toggle"`。
- 若 [ChatToolbar.source.test.ts](file:///c:/Project/Hpp/src/components/layout/ChatToolbar.source.test.ts) 有 `thinkingLevelMode` 断言，同步更新为使用 `getEffectiveThinkingLevelMode`。
- [shared/models.test.ts](file:///c:/Project/Hpp/shared/models.test.ts)：新增 `getEffectiveThinkingLevelMode` 单元测试（levels 模式 / toggle 模式 / undefined / undefined+0 levels → toggle）。

## Assumptions & Decisions

1. **「内置模型」仅 pi 有实际目录检测**：pi 的 `getDirectoryModelEntry` 可查目录。codex/claude 用 `fixedModelCapabilities: true` 统一处理（隐藏全部能力控件，能力从 `modelDefaults` 取）。droid/opencode 无内置目录，所有模型 `isBuiltin: false`（显示全部控件）。
2. **内置模型能力由目录权威**：pi `normalizeModel` 对内置模型从目录条目读 `reasoning`/`imageInput`，避免 models.json 陈旧值经 `combineAgentModels` 覆盖后端正确值。
3. **`hasThinkingLevels` 保留但不再被弹窗使用**：弹窗改用 `isBuiltin`/`fixedModelCapabilities` 判断；`hasThinkingLevels` 仍按 `!isBuiltin` 计算，保持类型/数据一致，减少移除带来的连锁改动。
4. **非内置模型 0 等级 → toggle**：用户勾选了「思考」但未勾选任何等级时，聊天框显示思考开关（开=medium，关=off），与 pi 内置无声明模型（mimo）行为一致。
5. **不修改 `toProviderConfig`**：`handleSave` 在 `capabilitiesManaged` 时清空 `supportedThinkingLevels`，`toProviderConfig` 自然删除 `thinkingLevelMap`，目录提供档位。

## Verification Steps

1. `npx vitest run electron/agent-plugins/config-providers.test.ts electron/agents/agent-config.test.ts electron/agents/agent-config.real2.test.ts electron/agents/agent-config.real3.test.ts` — 验证 `isBuiltin` 与 enrich 逻辑。
2. `npx vitest run electron/plugin-backends/pi/worker.test.ts` — 验证 `thinkingLevelMode` 调整 + 新增 1 档测试。
3. `npx vitest run shared/models.test.ts` — 验证 `getEffectiveThinkingLevelMode`。
4. `npx vitest run src/components/layout/ChatToolbar.source.test.ts src/components/sidebar/AgentConfigModal.test.ts src/components/sidebar/AgentSettingsView.source.test.ts` — 验证 UI 渲染。
5. `npx vitest run mobile/src/app-capabilities-source.test.ts` — 验证 mobile 推导。
6. 手动验证：pi 配置弹窗中内置模型（deepseek/mimo）不显示图片/思考/思考档位控件；自定义模型（GLM-5.1）显示全部控件；聊天框中自定义模型只勾 1 档时显示开关。
