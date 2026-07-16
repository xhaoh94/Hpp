import React, { useState, useCallback, useEffect, useRef } from 'react'
import { Copy, Download, LoaderCircle, Minus, RotateCcw, Square, X } from 'lucide-react'
import type { AppUpdateStatus } from '@/types'
import './TitleBar.css'

interface TitleBarProps {
  title?: string
}

const TitleBar: React.FC<TitleBarProps> = ({ title = 'Hpp' }) => {
  const [maximized, setMaximized] = useState(false)
  const [updateStatus, setUpdateStatus] = useState<AppUpdateStatus | null>(null)
  const [updateBusy, setUpdateBusy] = useState(false)
  const [showUpdatePrompt, setShowUpdatePrompt] = useState(false)
  const updatePromptRef = useRef<HTMLSpanElement | null>(null)

  useEffect(() => {
    let cancelled = false
    window.electronAPI?.getAppUpdateStatus()
      .then((status) => {
        if (!cancelled) setUpdateStatus(status)
      })
      .catch(() => undefined)
    const unsubscribe = window.electronAPI?.onAppUpdateStatus?.((status) => {
      setUpdateStatus(status)
    })
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [])

  useEffect(() => {
    if (updateStatus?.state !== 'available') {
      setShowUpdatePrompt(false)
    }
  }, [updateStatus?.state])

  useEffect(() => {
    if (!showUpdatePrompt) return

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (target && updatePromptRef.current?.contains(target)) return
      setShowUpdatePrompt(false)
    }

    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [showUpdatePrompt])

  const handleMinimize = useCallback(() => {
    window.electronAPI?.minimize()
  }, [])

  const handleToggleMaximize = useCallback(() => {
    window.electronAPI?.maximize()
    setMaximized((prev) => !prev)
  }, [])

  const handleClose = useCallback(() => {
    window.electronAPI?.close()
  }, [])

  const handleUpdateClick = useCallback(async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (!updateStatus || updateBusy) return

    if (updateStatus.state === 'available') {
      setShowUpdatePrompt((prev) => !prev)
      return
    }

    if (updateStatus.state !== 'downloaded') return

    setUpdateBusy(true)
    try {
      const result = await window.electronAPI.installAppUpdate()
      if (result.status) setUpdateStatus(result.status)
    } finally {
      setUpdateBusy(false)
    }
  }, [updateBusy, updateStatus])

  const handleDownloadUpdate = useCallback(async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (!updateStatus || updateStatus.state !== 'available' || updateBusy) return

    setUpdateBusy(true)
    try {
      const result = await window.electronAPI.downloadAppUpdate()
      if (result.status) setUpdateStatus(result.status)
      if (result.success) setShowUpdatePrompt(false)
    } finally {
      setUpdateBusy(false)
    }
  }, [updateBusy, updateStatus])

  const updateButtonVisible =
    updateStatus?.state === 'available' ||
    updateStatus?.state === 'downloading' ||
    updateStatus?.state === 'downloaded'
  const updateTitle = updateStatus?.state === 'downloaded'
    ? `Hpp v${updateStatus.version || ''} 已下载，点击重启安装`
    : updateStatus?.state === 'downloading'
      ? `正在下载 Hpp v${updateStatus.version || ''}`
      : `发现 Hpp v${updateStatus?.version || ''} 新版本`
  const updateProgress = typeof updateStatus?.percent === 'number'
    ? `${Math.max(0, Math.min(100, updateStatus.percent)).toFixed(0)}%`
    : ''
  const updateVersionLabel = updateStatus?.version ? `Hpp v${updateStatus.version}` : '新版本'

  return (
    <div className="app-titlebar">
      <div className="titlebar-drag-region" onDoubleClick={handleToggleMaximize}>
        <span className="titlebar-title-group">
          <span className="titlebar-title">{title}</span>
          {updateButtonVisible && (
            <span className="titlebar-update-wrap" ref={updatePromptRef}>
              <button
                type="button"
                className={`titlebar-update-btn ${updateStatus?.state === 'downloading' ? 'downloading' : ''} ${showUpdatePrompt ? 'active' : ''}`}
                onClick={handleUpdateClick}
                onDoubleClick={(event) => event.stopPropagation()}
                disabled={updateBusy || updateStatus?.state === 'downloading'}
                title={updateTitle}
                aria-label={updateTitle}
              >
                {updateStatus?.state === 'downloaded' ? (
                  <RotateCcw size={13} />
                ) : updateStatus?.state === 'downloading' ? (
                  <LoaderCircle size={13} />
                ) : (
                  <Download size={13} />
                )}
                {updateStatus?.state === 'downloading' && updateProgress && (
                  <span className="titlebar-update-progress">{updateProgress}</span>
                )}
              </button>
              {showUpdatePrompt && updateStatus?.state === 'available' && (
                <span
                  className="titlebar-update-popover"
                  role="dialog"
                  aria-label="发现新版本"
                  onClick={(event) => event.stopPropagation()}
                  onMouseDown={(event) => event.stopPropagation()}
                >
                  <span className="titlebar-update-popover-header">
                    <span className="titlebar-update-popover-title">发现新版本</span>
                    <button
                      type="button"
                      className="titlebar-update-popover-close"
                      onClick={() => setShowUpdatePrompt(false)}
                      aria-label="关闭"
                    >
                      <X size={12} />
                    </button>
                  </span>
                  <span className="titlebar-update-popover-body">
                    {updateVersionLabel} 可用，是否现在下载？
                  </span>
                  <span className="titlebar-update-popover-actions">
                    <button type="button" onClick={() => setShowUpdatePrompt(false)}>
                      稍后
                    </button>
                    <button type="button" className="primary" onClick={handleDownloadUpdate} disabled={updateBusy}>
                      {updateBusy ? '准备下载...' : '下载更新'}
                    </button>
                  </span>
                </span>
              )}
            </span>
          )}
        </span>
      </div>

      <div className="titlebar-controls">
        <button
          className="titlebar-btn titlebar-btn-minimize"
          onClick={handleMinimize}
          title="最小化"
          aria-label="最小化窗口"
        >
          <Minus size={15} strokeWidth={1.5} />
        </button>
        <button
          className="titlebar-btn titlebar-btn-maximize"
          onClick={handleToggleMaximize}
          title={maximized ? '还原' : '最大化'}
          aria-label={maximized ? '还原窗口' : '最大化窗口'}
        >
          {maximized ? (
            <Copy size={13} strokeWidth={1.5} />
          ) : (
            <Square size={12} strokeWidth={1.5} />
          )}
        </button>
        <button
          className="titlebar-btn titlebar-btn-close"
          onClick={handleClose}
          title="关闭"
          aria-label="关闭窗口"
        >
          <X size={15} strokeWidth={1.5} />
        </button>
      </div>
    </div>
  )
}

export default TitleBar
