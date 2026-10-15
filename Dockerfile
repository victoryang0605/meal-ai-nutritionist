# 三餐 AI 营养师 后端镜像（Express + DeepSeek/Agnes AI）
# 使用官方 node 镜像（云托管对官方常用镜像有缓存加速，拉取稳定）
FROM node:20-slim

WORKDIR /app

# 安装 CA 根证书：slim 镜像可能缺失，会导致容器内 HTTPS 出站失败
# （症状：Node fetch 报 "fetch failed"，微信登录 / AI 识图全部异常）
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# 依赖使用国内 npm 镜像（npmmirror），避免直连 npm 官方源超时
RUN npm config set registry https://registry.npmmirror.com

# 先装依赖（利用层缓存；lockfile 已指向 npmmirror，npm ci 直接命中）
COPY package.json package-lock.json* ./
RUN npm ci || npm install

# 拷贝源码并构建（esbuild 打包 server -> dist/server.mjs）
COPY . .
RUN npm run build

ENV NODE_ENV=production

EXPOSE 3000

# ESM 产物（import.meta 在 ESM 下正常工作）
CMD ["node", "dist/server.mjs"]
