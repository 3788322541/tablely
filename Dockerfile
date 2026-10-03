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
