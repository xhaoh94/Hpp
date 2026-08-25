---
description: 先由 scout 调查代码库，再由 planner 制定计划，不执行修改
---
请使用 `subagent` 工具的 `chain` 参数执行以下工作流：

1. 首先使用 `scout` Agent，调查与以下请求相关的代码、文件、符号、测试和风险：$@
2. 然后使用 `planner` Agent，结合上一步通过 `{previous}` 传递的调查摘要，为“$@”制定可执行的实施计划。

必须以 chain 模式执行，并通过 `{previous}` 传递上一步输出。
只返回计划，不要在主会话中直接实施修改。
