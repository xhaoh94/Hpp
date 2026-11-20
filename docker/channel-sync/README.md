# Hpp 渠道配置同步服务（NAS 端）

Hpp 的渠道（Provider）配置平时存在每台机器的 `hpp-data/settings.json` 里。这个服务把配置包集中放到飞牛 NAS 上，让多台安装了 Hpp 的机器可以在**手动点击**时备份和拉取同一份渠道配置（含 API Key）。

它是一个零依赖的单文件 Node 服务，只提供四个接口：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 存活探测，不需要 Token，只返回 revision |
| GET | `/snapshot` | 取最新快照（需要 Token） |
| PUT | `/snapshot` | 上传配置包，revision 自增（需要 Token） |
| GET | `/snapshots` | 列出历史快照 |
| GET | `/snapshot/<revision>` | 取指定历史快照 |

服务不主动连外网、不定时任务、不推送通知：所有同步都由 Hpp 里的按钮触发。

## 用 Hpp 自动部署（推荐）

Hpp 的「Agent 配置 → 同步 → 添加服务器」会用 SSH 完成下面全部步骤：

1. 填 NAS 地址、SSH 端口（默认 22）、账号和密码；
2. 点「测试连接」确认 Docker 和 sudo 可用（会显示主机指纹和容器状态）；
3. 点「保存并部署」：Hpp 建目录、上传 `server.mjs`、生成 Token、启动容器，最后请求 `/health` 验证。

部署目录默认 `/opt/hpp-channel-sync`（表单里可改，飞牛这类 NAS 也可以填 `/vol1/docker/hpp-channel-sync`），`data/` 保留历史备份，重复部署只重建容器。账号需要能执行 `docker`：root，或飞牛的管理员账号（在 Administrators 组且 sudo 可用）。首次连接会记录 SSH 主机指纹，之后指纹变化会中止连接。

同一台 NAS 也可以先按下面的方式手动部署，再在 Hpp 里「添加服务器」填服务地址——前提是手动生成并保存了一个 Token。

## 手动部署（不经过 Hpp）

1. 把整个 `channel-sync` 目录上传到服务器，例如 `/opt/hpp-channel-sync`。
2. 在目录里创建 `.env`，写入一个够长的随机 Token：

   ```bash
   # 在任意一台装了 openssl 的机器上生成
   openssl rand -hex 32
   ```

   ```dotenv
   HPP_SYNC_TOKEN=把上一步生成的字符串粘贴到这里
   ```

3. 启动容器：

   ```bash
   docker compose up -d --build
   ```

   飞牛 Docker 的「Compose」界面也可以直接粘贴 `docker-compose.yml` 的内容，记得把 `HPP_SYNC_TOKEN` 填成真实值。

4. 确认服务活着：

   ```bash
   curl http://127.0.0.1:8787/health
   # {"ok":true,"service":"hpp-channel-sync","version":1,"revision":0}
   ```

## 组网地址

Hpp 里要填的是**比扬云组网分配的那台 NAS 地址**，不是 `127.0.0.1`：

```text
http://<比扬云分配给 NAS 的 IP>:8787
```

- 端口映射保持 `8787:8787`；如果改了宿主机端口，Hpp 里也要跟着改。
- 只想让组网内访问时，把 compose 的端口映射改成 `"<组网网卡IP>:8787:8787"`，或用飞牛防火墙限制来源网段。
- 组网是二层/三层 VPN，服务本身走明文 HTTP 即可；不需要再套 HTTPS，也就不会遇到自签证书问题。

## 在 Hpp 里使用

打开「Agent 配置」标题栏的同步入口：

- **备份到 NAS**：收集当前所有 Agent 的渠道（含 API Key）上传，NAS 上 revision 加一。
- **从 NAS 拉取**：下载最新快照，然后走与「导入 JSON」完全相同的冲突处理界面（同名渠道可选覆盖 / 跳过 / 另存为新 ID），确认后才写本地配置。

拉取不会自动覆盖本地：必须先看到冲突列表并点「开始导入」。这是有意的——渠道配置写错会直接影响能不能用。

## 数据与恢复

- 最新快照：`data/snapshot.json`
- 历史快照：`data/history/000001.json`、`000002.json`…（默认保留 20 份，`HPP_SYNC_HISTORY_LIMIT` 可调）
- 版本号：`data/meta.json`

误覆盖后，可以从历史文件里取回 `payload`，在 Hpp 里用「导入 JSON」加载，或直接：

```bash
curl -H "Authorization: Bearer $HPP_SYNC_TOKEN" \
  http://127.0.0.1:8787/snapshot/3 > old.json
```

## 安全说明

- 配置包里 **API Key 是明文**（个人自用场景，换取「换机器不用重新填」）。因此该服务不要暴露到公网，只放在组网/内网里。
- Token 建议 32 字节以上随机串；服务端比对用哈希 + `timingSafeEqual`，不会因长度差异泄露信息。
- 容器以非 root 用户运行，只有 `/data` 可写。
- 需要更严格的隔离时，把 `docker-compose.yml` 的端口映射绑定到组网网卡地址，而不是 `0.0.0.0`。
