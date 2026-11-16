import { useEffect, useRef } from "react";

/**
 * 弹出菜单的统一关闭逻辑：点外面 / Esc / 滚动 / 窗口失焦都关掉。
 * `ignoreSelector` 用来放过打开菜单的那个触发按钮，否则点第二次不会关。
 */
export function useMenuDismiss(active: boolean, onClose: () => void, ignoreSelector: string) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!active) return;
    const close = () => closeRef.current();
    const handlePointerDown = (event: MouseEvent) => {
      if ((event.target as HTMLElement | null)?.closest?.(ignoreSelector)) return;
      close();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    // 菜单内部滚动（长列表）会在捕获阶段冒到 window，不能当成"页面滚动"关掉菜单。
    const handleScroll = (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest?.(ignoreSelector)) return;
      close();
    };
    document.addEventListener("mousedown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [active, ignoreSelector]);
}
