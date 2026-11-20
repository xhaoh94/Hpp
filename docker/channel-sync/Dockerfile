FROM node:22-alpine

WORKDIR /app

# 单文件零依赖服务，不需要 npm install。
COPY server.mjs ./server.mjs

# 用非 root 运行；/data 是唯一可写目录。
RUN addgroup -S hpp \
 && adduser -S hpp -G hpp \
 && mkdir -p /data \
 && chown -R hpp:hpp /data
USER hpp

ENV HPP_SYNC_PORT=8787 \
    HPP_SYNC_DATA_DIR=/data \
    NODE_ENV=production

EXPOSE 8787
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HPP_SYNC_PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
