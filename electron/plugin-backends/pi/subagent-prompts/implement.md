---
description: scout 调查、planner 规划、worker 在隔离上下文中实施完整任务
---
请使用 `subagent` 工具的 `chain` 参数执行以下工作流：

1. 首先使用 `scout` Agent，调查与以下请求相关的代码、文件、符号、测试和风险：$@
2. 然后使用 `planner` Agent，结合上一步通过 `{previous}` 传递的调查摘要，为“$@”制定实施计划。
3. 最后使用 `worker` Agent，结合前两步通过 `{previous}` 传递的上下文，实施该计划，运行针对性测试，并报告修改和剩余风险。

必须以 chain 模式执行，并在每一步之间通过 `{previous}` 传递输出。
