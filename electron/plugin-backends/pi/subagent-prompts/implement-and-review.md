---
description: worker 实施、reviewer 审查、worker 根据反馈修正
---
请使用 `subagent` 工具的 `chain` 参数执行以下工作流：

1. 首先使用 `worker` Agent，实施以下请求：$@
2. 然后使用 `reviewer` Agent，结合上一步通过 `{previous}` 传递的实现摘要，审查实现、边界条件、异步生命周期、错误处理和测试覆盖。
3. 最后再次使用 `worker` Agent，结合 reviewer 通过 `{previous}` 传递的反馈，修正发现的问题并运行针对性测试。

必须以 chain 模式执行，并在每一步之间通过 `{previous}` 传递输出。
