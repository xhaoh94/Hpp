import { useEffect, useState } from "react";
import {
  ensureLocalMediaBaseUrl,
  getLocalMediaBaseUrl,
} from "@/lib/media-preview";

/** 本地视频流服务前缀；首次读取走 IPC，之后命中模块级缓存。 */
export function useLocalMediaBaseUrl() {
  const [baseUrl, setBaseUrl] = useState(getLocalMediaBaseUrl);
  useEffect(() => {
    if (baseUrl) return;
    let cancelled = false;
    void ensureLocalMediaBaseUrl().then((value) => {
      if (!cancelled && value) setBaseUrl(value);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [baseUrl]);
  return baseUrl;
}
