/**
 * 测试脚本：向移动端发送交互问卷
 *
 * 使用方法：
 * 1. 确保移动端已连接到桌面端
 * 2. 运行：node scripts/test-interaction.mjs
 *
 * 这会通过 WebSocket 直接向移动端发送一个测试问卷
 */

import WebSocket from "ws";

const DESKTOP_URL = "ws://localhost:47831/api/v1/ws";

// 模拟一个已配对设备的 token（需要替换为实际的 token）
// 或者直接通过桌面端的渲染器发送交互事件

const testInteraction = {
  type: "session.interaction",
  sessionId: "test-session", // 替换为实际的会话 ID
  interaction: {
    sessionId: "test-session",
    requestId: `test-${Date.now()}`,
    method: "ask_user_question",
    questions: [
      {
        id: "test-q1",
        question: "你希望输入区采用哪种默认高度？",
        header: "UI 偏好",
        options: [
          { label: "紧凑", value: "compact", description: "默认一行，按内容增高" },
          { label: "宽松", value: "comfortable", description: "默认两行" },
        ],
      },
      {
        id: "test-q2",
        question: "选择你喜欢的颜色（可多选）：",
        header: "颜色",
        multiSelect: true,
        options: [
          { label: "红色", value: "red" },
          { label: "蓝色", value: "blue" },
          { label: "绿色", value: "green" },
        ],
      },
    ],
  },
};

console.log("测试问卷数据：");
console.log(JSON.stringify(testInteraction, null, 2));
console.log("\n提示：此脚本需要配合桌面端使用。");
console.log("请在桌面端的会话中让 Agent 调用 ask_user_question 来触发真正的交互。");
