import React, { useState, useCallback } from 'react'
import './TitleBar.css'

interface TitleBarProps {
  title?: string
}

const TitleBar: React.FC<TitleBarProps> = ({ title = 'Hpp' }) => {
  const [maximized, setMaximized] = useState(false)

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

  return (
    <div className="app-titlebar">
      <div className="titlebar-drag-region" onDoubleClick={handleToggleMaximize}>
        <span className="titlebar-title">{title}</span>
      </div>

      <div className="titlebar-controls">
        <button
          className="titlebar-btn titlebar-btn-minimize"
          onClick={handleMinimize}
          title="最小化"
          aria-label="最小化窗口"
        >
          <svg width="12" height="12" viewBox="0 0 12 12">
            <rect x="2" y="5.5" width="8" height="1" fill="currentColor" />
          </svg>
        </button>
        <button
          className="titlebar-btn titlebar-btn-maximize"
          onClick={handleToggleMaximize}
          title={maximized ? '还原' : '最大化'}
          aria-label={maximized ? '还原窗口' : '最大化窗口'}
        >
          {maximized ? (
            <svg width="12" height="12" viewBox="0 0 12 12">
              <rect x="3" y="3" width="6" height="6" fill="none" stroke="currentColor" strokeWidth="1" />
              <rect x="1" y="5" width="6" height="6" fill="none" stroke="currentColor" strokeWidth="1" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 12 12">
              <rect x="2" y="2" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="1" />
            </svg>
          )}
        </button>
        <button
          className="titlebar-btn titlebar-btn-close"
          onClick={handleClose}
          title="关闭"
          aria-label="关闭窗口"
        >
          <svg width="12" height="12" viewBox="0 0 12 12">
            <line x1="2" y1="2" x2="10" y2="10" stroke="currentColor" strokeWidth="1.2" />
            <line x1="10" y1="2" x2="2" y2="10" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
      </div>
    </div>
  )
}

export default TitleBar
