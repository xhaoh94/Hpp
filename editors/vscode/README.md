# Hpp Bridge

把 VSCode 里选中的代码或当前文件发送到 Hpp 的聊天输入框。

## 用法

- `Hpp: 发送选中代码` — 有选区时右键，或 `Ctrl+Alt+H`（macOS `Cmd+Alt+H`）
- `Hpp: 发送当前行` — 没有选区时右键，光标所在行（右键会先把光标移到点击位置）
- `Hpp: 发送当前文件` — 编辑器右键菜单，或在资源管理器里右键一个文件；未保存、远程开发（SSH/WSL）的文件会连同内容一起发送。资源管理器支持多选，选中的文件和文件夹会逐个发送
- `Hpp: 发送文件夹` — 资源管理器里右键文件夹，只发路径不读内容；多选时同样支持批量发送
- `Hpp: 查看连接状态` — 命令面板

发送后 Hpp 会在当前会话的输入框里插入路径引用或代码块；Hpp 没开会话时会提示失败。

## 连接方式

Hpp 启动时会在 `<userData>/hpp-data/editor-bridge.json` 写下回环端口和一次性令牌，
本扩展读这个文件后直接 POST 到 `127.0.0.1`。所以 **Hpp 必须先启动**，端口变了也无所谓。

文件未保存（dirty）或不是本地文件（SSH/WSL）时，扩展会连同字面内容一起发过去；
已保存的本地文件只发路径和行号，由 Hpp 自己读盘。资源管理器里右键已保存的本地文件只发路径，
右键未保存或远程文件则连同内容一起发送。多选时按选中顺序逐个发送，第一项会把 Hpp 提到前台，
后续项不再抢焦点。

默认查找位置：

- Windows `%APPDATA%\hpp\hpp-data\editor-bridge.json`
- macOS `~/Library/Application Support/hpp/hpp-data/editor-bridge.json`
- Linux `$XDG_CONFIG_HOME/hpp/hpp-data/editor-bridge.json`

自定义位置用设置项 `hpp.discoveryPath`。
