import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, CheckCircle2, ChevronDown, Copy, Link2, LoaderCircle, QrCode, RefreshCw, ShieldCheck, Trash2, Wifi, WifiOff } from "lucide-react";
import type { RemoteAccessStatus, RemotePairingOffer } from "@/types";
import { showFloatingToastMessage } from "@/lib/floating-toast";

const ANDROID_EMULATOR_ADDRESS = "10.0.2.2";

function getAddressKind(address: string) {
  if (address === ANDROID_EMULATOR_ADDRESS) return "Android Studio 模拟器宿主机";
  if (/^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address)) return "组网地址";
  if (/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(address)) return "局域网地址";
  if (/^https?:\/\//i.test(address)) return "自定义代理地址";
  return "自定义地址";
}

export function RemoteAccessSettings({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<RemoteAccessStatus | null>(null);
  const [pairing, setPairing] = useState<RemotePairingOffer | null>(null);
  const [port, setPort] = useState("47831");
  const [bindAddress, setBindAddress] = useState("0.0.0.0");
  const [advertiseAddress, setAdvertiseAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pairingLinkCopied, setPairingLinkCopied] = useState(false);
  const [addressPickerOpen, setAddressPickerOpen] = useState(false);
  const copyFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const addressPickerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => () => {
    if (copyFeedbackTimerRef.current) clearTimeout(copyFeedbackTimerRef.current);
  }, []);

  useEffect(() => {
    if (!addressPickerOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!addressPickerRef.current?.contains(event.target as Node)) setAddressPickerOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAddressPickerOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [addressPickerOpen]);

  const applyStatus = useCallback((next: RemoteAccessStatus) => {
    setStatus(next);
    setPort(String(next.port));
    setBindAddress(next.bindAddress);
    setAdvertiseAddress(next.advertiseAddress);
  }, []);

  const refresh = useCallback(async () => {
    try {
      applyStatus(await window.electronAPI.remoteGetAccessStatus());
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [applyStatus]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const configure = useCallback(async (enabled = status?.enabled ?? false) => {
    setBusy(true);
    setError("");
    setPairing(null);
    try {
      const next = await window.electronAPI.remoteConfigureAccess({
        enabled,
        port: Number(port),
        bindAddress,
        advertiseAddress,
      });
      applyStatus(next);
      if (next.error) setError(next.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [advertiseAddress, applyStatus, bindAddress, port, status?.enabled]);

  const beginPairing = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      await configure(true);
      const offer = await window.electronAPI.remoteBeginPairing();
      setPairing(offer);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [configure, refresh]);

  const connectionUrl = useMemo(() => {
    if (!status) return "";
    if (/^https?:\/\//i.test(advertiseAddress)) return advertiseAddress.replace(/\/$/, "");
    return `http://${advertiseAddress || "127.0.0.1"}:${port}`;
  }, [advertiseAddress, port, status]);

  const addressOptions = useMemo(() => [...new Set([
    ...(status?.addresses || []),
    ANDROID_EMULATOR_ADDRESS,
    advertiseAddress.trim(),
  ].filter(Boolean))], [advertiseAddress, status?.addresses]);

  const revoke = async (deviceId: string) => {
    setBusy(true);
    try {
      applyStatus(await window.electronAPI.remoteRevokeDevice(deviceId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const copyPairingLink = useCallback(async () => {
    if (!pairing) return;
    try {
      await navigator.clipboard.writeText(pairing.webPairingUrl);
      if (copyFeedbackTimerRef.current) clearTimeout(copyFeedbackTimerRef.current);
      setPairingLinkCopied(true);
      copyFeedbackTimerRef.current = setTimeout(() => {
        setPairingLinkCopied(false);
        copyFeedbackTimerRef.current = null;
      }, 1800);
      showFloatingToastMessage("已复制");
    } catch (err) {
      setError(`复制失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [pairing]);

  return (
    <div className="settings-modal-overlay remote-access-overlay" onClick={onClose}>
      <div className="settings-modal remote-access-modal" onClick={(event) => event.stopPropagation()}>
        <div className="settings-modal-header">
          <div className="remote-access-title">
            <ShieldCheck size={18} />
            <div>
              <h3>远程访问</h3>
              <span>仅通过可信局域网或 Tailscale/WireGuard 使用</span>
            </div>
          </div>
          <button onClick={onClose} className="settings-modal-close" aria-label="关闭">×</button>
        </div>

        <div className="settings-modal-content remote-access-content">
          <div className={`remote-access-status ${status?.running ? "online" : "offline"}`}>
            {status?.running ? <Wifi size={17} /> : <WifiOff size={17} />}
            <span>{status?.running ? "服务正在运行" : "服务未运行"}</span>
            <code>{connectionUrl || "正在读取..."}</code>
            <button type="button" className="btn-icon" onClick={() => void refresh()} title="刷新状态">
              <RefreshCw size={15} />
            </button>
          </div>

          <div className="remote-access-grid">
            <label>
              <span>监听地址</span>
              <input className="input-field" value={bindAddress} onChange={(event) => setBindAddress(event.target.value)} />
              <small>使用 0.0.0.0 接受局域网和组网连接。</small>
            </label>
            <label>
              <span>端口</span>
              <input className="input-field" type="number" min={1024} max={65535} value={port} onChange={(event) => setPort(event.target.value)} />
            </label>
            <div className="remote-access-field remote-access-wide">
              <span>二维码中使用的地址</span>
              <div ref={addressPickerRef} className={`remote-address-picker ${addressPickerOpen ? "open" : ""}`}>
                <input
                  className="input-field"
                  value={advertiseAddress}
                  onChange={(event) => setAdvertiseAddress(event.target.value)}
                  placeholder="192.168.x.x 或 Tailscale 地址"
                />
                <button
                  type="button"
                  className="remote-address-picker-trigger"
                  aria-haspopup="listbox"
                  aria-expanded={addressPickerOpen}
                  onClick={() => setAddressPickerOpen((open) => !open)}
                  title="选择地址"
                >
                  <ChevronDown size={16} />
                </button>
                {addressPickerOpen && (
                  <div className="remote-address-picker-menu" role="listbox" aria-label="可用连接地址">
                    {addressOptions.map((address) => {
                      const selected = advertiseAddress.trim() === address;
                      return (
                        <button
                          type="button"
                          role="option"
                          aria-selected={selected}
                          className={selected ? "selected" : ""}
                          key={address}
                          onClick={() => {
                            setAdvertiseAddress(address);
                            setAddressPickerOpen(false);
                          }}
                        >
                          <span><strong>{address}</strong><small>{getAddressKind(address)}</small></span>
                          {selected && <Check size={14} />}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
              <small>可选择检测到的地址，也可直接输入反向代理或其他私网地址。</small>
            </div>
          </div>

          <div className="remote-access-actions">
            <label className="settings-toggle-row remote-access-toggle">
              <span>
                <span className="settings-toggle-title">启用远程访问</span>
                <span className="settings-toggle-desc">桌面退出或电脑休眠后将无法连接。</span>
              </span>
              <input
                type="checkbox"
                checked={status?.enabled === true}
                disabled={busy || !status}
                onChange={(event) => void configure(event.target.checked)}
              />
            </label>
            <button type="button" className="filter-add-btn" onClick={() => void configure()} disabled={busy || !status}>
              {busy ? <LoaderCircle className="agent-config-spin" size={15} /> : <Link2 size={15} />}
              保存连接设置
            </button>
            <button type="button" className="filter-add-btn primary" onClick={() => void beginPairing()} disabled={busy || !status}>
              <QrCode size={15} />
              配对
            </button>
          </div>

          {error && <div className="remote-access-error">{error}</div>}

          {pairing && (
            <div className="remote-pairing">
              <img src={pairing.qrDataUrl} alt="Hpp 配对二维码" />
              <div>
                <strong>使用 Hpp 扫描或在浏览器打开</strong>
                <span>Android 与网页共用此二维码，将在 {new Date(pairing.expiresAt).toLocaleTimeString()} 失效。</span>
                <button
                  type="button"
                  className={`filter-add-btn remote-copy-button ${pairingLinkCopied ? "copied" : ""}`}
                  onClick={() => void copyPairingLink()}
                >
                  {pairingLinkCopied ? <CheckCircle2 size={14} /> : <Copy size={14} />}
                  {pairingLinkCopied ? "已复制" : "复制配对链接"}
                </button>
              </div>
            </div>
          )}

          <section className="remote-device-section">
            <div className="remote-device-heading">
              <div>
                <h4>已配对设备</h4>
                <span>{status?.devices.length || 0} 台设备</span>
              </div>
            </div>
            <div className="remote-device-list">
              {status?.devices.map((device) => (
                <div className="remote-device-row" key={device.id}>
                  <div>
                    <strong>{device.name}</strong>
                    <span>
                      配对于 {new Date(device.createdAt).toLocaleString()}
                      {device.lastConnectedAt ? ` · 最近连接 ${new Date(device.lastConnectedAt).toLocaleString()}` : ""}
                    </span>
                  </div>
                  <button type="button" className="btn-icon danger" onClick={() => void revoke(device.id)} disabled={busy} title="吊销设备">
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
              {status && status.devices.length === 0 && <div className="remote-device-empty">尚未配对设备</div>}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
