import { defineConfig } from "vitest/config";

/**
 * 单元测试配置（与 vite.config.ts 分开）
 *
 * 单独一份配置是刻意的：`vite.config.ts` 挂了 `reactRouter()` 插件，
 * 那套插件只对构建/开发有意义，放进单测会拖慢启动并引入无关失败。
 * 这里只跑纯函数与服务层的 Node 环境单测（§21.1）：
 *   - 单元：本配置（`npm run test`）
 *   - 集成：M2 起加本地 Postgres（§21.1）
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["app/**/*.test.ts"],
    // 单测不连真库：给 PrismaClient 一个占位连接串，避免构造期读不到 env 报错
    env: {
      DATABASE_URL:
        "postgresql://tablely:tablely@localhost:5432/tablely?schema=public",
    },
  },
});