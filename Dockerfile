# ---------- build stage ----------
FROM node:20-alpine AS build
RUN apk add --no-cache openssl

WORKDIR /app

# workspace 目录需先存在（npm workspaces）
COPY package.json package-lock.json* ./
COPY extensions ./extensions
RUN npm ci

COPY . .
RUN npx prisma generate && npm run build

# ---------- runtime stage ----------
FROM node:20-alpine
RUN apk add --no-cache openssl

WORKDIR /app
ENV NODE_ENV=production

# 镜像版本号：`/healthz` 与结构化日志用它标明「现在跑的是哪个提交」（回滚 / 排查必需）。
# 由 scripts/deploy.sh 以 `--build-arg APP_VERSION=<短SHA>` 注入；未注入时为 0.0.0-dev。
# ⚠️ 不要用 compose 的 env_file 覆盖它（.env 里的值会盖过镜像 ENV）。
ARG APP_VERSION=0.0.0-dev
ENV APP_VERSION=$APP_VERSION

COPY package.json package-lock.json* ./
COPY extensions ./extensions
# prisma CLI 在生产依赖中，运行时执行 migrate deploy
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/build ./build
COPY --from=build /app/prisma ./prisma

# Render/平台注入 PORT，react-router-serve 默认监听全部网卡
EXPOSE 3000

# setup: prisma generate + prisma migrate deploy，然后启动
CMD ["npm", "run", "docker-start"]
