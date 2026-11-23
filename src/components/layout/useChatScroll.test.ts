import { describe, expect, it } from "vitest";
import chatScrollSource from "./useChatScroll.ts?raw";
import { shouldShowScrollBottom } from "./useChatScroll";

describe("返回底部按钮的显示条件", () => {
  it("内容一屏放得下时永远不显示", () => {
    // 新会话 / 短回答：滚轮、方向键都改不动视图，distance 恒为 0。
    // 以前这里会用 `!autoFollow` 兜底，于是滚一下（哪怕滚不动）就冒出按钮。
    expect(shouldShowScrollBottom(0, 0)).toBe(false);
    expect(shouldShowScrollBottom(200, 0)).toBe(false);
  });

  it("有滚动余量时只在真的离开底部之后显示", () => {
    expect(shouldShowScrollBottom(12, 2_000)).toBe(false);
    expect(shouldShowScrollBottom(51, 2_000)).toBe(true);
  });
});

describe("短会话不会被当成「用户离开了底部」", () => {
  const startUserScrollSource = chatScrollSource.slice(
    chatScrollSource.indexOf("const startUserScroll"),
    chatScrollSource.indexOf("const keepAtBottom"),
  );
  const updateScrollBottomStateSource = chatScrollSource.slice(
    chatScrollSource.indexOf("const updateScrollBottomState"),
    chatScrollSource.indexOf("const beginScrollOperation"),
  );

  it("滚轮/指针/键盘在没有滚动余量时不关闭自动跟随", () => {
    expect(startUserScrollSource).toContain("getScrollOverflow(el) <= AUTO_FOLLOW_BOTTOM_EPSILON");
  });

  it("按钮显隐只由「能滚 + 离开底部」决定，不再看 autoFollow", () => {
    expect(updateScrollBottomStateSource).toContain("shouldShowScrollBottom(distance, getScrollOverflow(el))");
    expect(updateScrollBottomStateSource).not.toContain("!autoFollowBottomRef.current");
    // 也不允许在滚动开始前抢先点亮：滚不动时会误亮，没滚出阈值时会闪。
    expect(startUserScrollSource).not.toContain("setShowScrollBottom");
  });
});
