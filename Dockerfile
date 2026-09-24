# 拓扑工作台生产镜像：构建后用零依赖的 Node 静态服务器发布
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# 复制构建产物与极简静态服务器（不依赖 npm 包）
COPY --from=build /app/dist ./dist
COPY docker/server.mjs ./server.mjs
# 容器内监听端口；由 Compose 的 WEB_PORT 映射到宿主机
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]
