import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Copy, Link2, LoaderCircle, QrCode, RefreshCw, ShieldCheck, Smartphone, Trash2, Wifi, WifiOff } from "lucide-react";
import type { RemoteAccessStatus, RemotePairingOffer } from "@/types";
import { buildRemoteCandidateUrls } from "@shared/remote-addresses";
import { showFloatingToastMessage } from "@/lib/floating-toast";

export function RemoteAccessSettings({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<RemoteAccessStatus | null>(null);
  const [pairing, setPairing] = useState<RemotePairingOffer | null>(null);
  const [deviceListOpen, setDeviceListOpen] = useState(false);
  const [port, setPort] = useState("47831");
  const [bindAddress, setBindAddress] = useState("0.0.0.0");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pairingLinkCopied, setPairingLinkCopied] = useState(false);
  const copyFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const closePairing = useCallback(() => {
    setPairing(null);
    setPairingLinkCopied(false);
  }, []);

  const closeDeviceList = useCallback(() => setDeviceListOpen(false), []);

  useEffect(() => () => {
    if (copyFeedbackTimerRef.current) clearTimeout(copyFeedbackTimerRef.current);
  }, []);

  useEffect(() => {
    if (!pairing && !deviceListOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (pairing) closePairing();
      else closeDeviceList();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [closeDeviceList, closePairing, deviceListOpen, pairing]);

  const applyStatus = useCallback((next: RemoteAccessStatus) => {
    setStatus(next);
    setPort(String(next.port));
    setBindAddress(next.bindAddress);
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
      });
      applyStatus(next);
      if (next.error) setError(next.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [applyStatus, bindAddress, port, status?.enabled]);

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
    return buildRemoteCandidateUrls(status.advertiseAddress, status.addresses, Number(port))[0] || "";
  }, [port, status]);

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
    <>
      <div className="settings-modal-overlay remote-access-overlay" onClick={onClose}>
        <div
          className="settings-modal remote-access-modal"
          role="dialog"
          aria-modal="true"
          aria-hidden={pairing || deviceListOpen ? true : undefined}
          aria-labelledby="remote-access-title"
          onClick={(event) => event.stopPropagation()}
        >
        <div className="settings-modal-header">
          <div className="remote-access-title">
            <ShieldCheck size={18} />
            <div>
              <h3 id="remote-access-title">远程访问</h3>
              <span>管理桌面连接、配对和已授权设备</span>
            </div>
          </div>
          <div className="remote-access-header-actions">
            <button
              type="button"
              className="remote-device-trigger"
              aria-label={`已配对设备，${status?.devices.length || 0} 台`}
              title="查看已配对设备"
              onClick={() => {
                setError("");
                setDeviceListOpen(true);
              }}
            >
              <Smartphone size={14} />
              <span>{status?.devices.length || 0}</span>
            </button>
            <button onClick={onClose} className="settings-modal-close" aria-label="关闭">×</button>
          </div>
        </div>

        <div className="settings-modal-content remote-access-content">
          <section className={`remote-access-overview ${status?.running ? "online" : "offline"}`}>
            <div className="remote-access-overview-main">
              <span className="remote-access-state-icon">
                {status?.running ? <Wifi size={17} /> : <WifiOff size={17} />}
              </span>
              <div>
                <strong>启用远程访问</strong>
                <span>{status?.running ? "服务正在运行，可接受远程连接" : "服务未运行，远程设备当前无法连接"}</span>
              </div>
            </div>
            <div className="remote-access-overview-actions">
              <button type="button" className="btn-icon" onClick={() => void refresh()} title="刷新状态">
                <RefreshCw size={15} />
              </button>
              <label className="settings-toggle-row remote-access-master-toggle" title="启用远程访问">
                <input
                  type="checkbox"
                  checked={status?.enabled === true}
                  disabled={busy || !status}
                  onChange={(event) => void configure(event.target.checked)}
                />
              </label>
            </div>
            <code className="remote-access-endpoint">{connectionUrl || "正在读取连接地址..."}</code>
          </section>

          {error && <div className="remote-access-error">{error}</div>}

          <section className="remote-access-section remote-connection-section">
            <div className="remote-section-heading">
              <div>
                <h4>连接设置</h4>
                <span>系统会自动检测可用地址，连接时优先使用局域网。</span>
              </div>
            </div>
            <div className="remote-access-grid">
              <label>
                <span>监听地址</span>
                <input className="input-field" value={bindAddress} onChange={(event) => setBindAddress(event.target.value)} />
              </label>
              <label className="remote-port-field">
                <span>端口</span>
                <input className="input-field" type="number" min={1024} max={65535} value={port} onChange={(event) => setPort(event.target.value)} />
              </label>
            </div>
            <div className="remote-access-actions">
              <span>监听地址建议保持 0.0.0.0，以同时接受局域网和组网连接。</span>
              <div>
                <button type="button" className="filter-add-btn" onClick={() => void configure()} disabled={busy || !status}>
                  {busy ? <LoaderCircle className="agent-config-spin" size={15} /> : <Link2 size={15} />}
                  保存
                </button>
                <button type="button" className="filter-add-btn primary" onClick={() => void beginPairing()} disabled={busy || !status}>
                  <QrCode size={15} />
                  配对设备
                </button>
              </div>
            </div>
          </section>

        </div>
      </div>
      </div>

      {pairing && (
        <div className="settings-modal-overlay remote-pairing-overlay" onClick={closePairing}>
          <div
            className="settings-modal remote-pairing-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="remote-pairing-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="settings-modal-header">
              <div className="remote-pairing-title">
                <QrCode size={18} />
                <h3 id="remote-pairing-title">配对设备</h3>
              </div>
              <button autoFocus onClick={closePairing} className="settings-modal-close" aria-label="关闭配对窗口">×</button>
            </div>
            <div className="remote-pairing-content">
              <div className="remote-pairing-qr">
                <img src={pairing.qrDataUrl} alt="Hpp 配对二维码" />
              </div>
              <div className="remote-pairing-copy">
                <strong>使用 Hpp 扫描二维码</strong>
                <span>Android 与网页共用此二维码，将在 {new Date(pairing.expiresAt).toLocaleTimeString()} 失效。</span>
              </div>
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
        </div>
      )}

      {deviceListOpen && (
        <div className="settings-modal-overlay remote-device-overlay" onClick={closeDeviceList}>
          <div
            className="settings-modal remote-device-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="remote-device-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="settings-modal-header">
              <div className="remote-device-modal-title">
                <Smartphone size={18} />
                <div>
                  <h3 id="remote-device-title">已配对设备</h3>
                  <span>{status?.devices.length || 0} 台已授权设备</span>
                </div>
              </div>
              <button autoFocus onClick={closeDeviceList} className="settings-modal-close" aria-label="关闭设备列表">×</button>
            </div>
            <div className="remote-device-modal-content">
              {error && <div className="remote-access-error">{error}</div>}
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
            </div>
          </div>
        </div>
      )}
    </>
  );
}
