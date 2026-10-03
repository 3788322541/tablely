/**
 * P2 店面 JS 体积断言（npm run check-bundle）
 *
 * §2.3.1 P2：主题扩展下发给**店面**的 JS，gzip 后 ≤ 15 KB
 * （阈值取自 `app/perf-limits.ts` 的 `BUNDLE_MAX_GZIP_BYTES`，此处只读不写，
 *  集中定义是 §2.3.1 的硬约束）。
 *
 * 为什么断言「扩展 `assets/` 里的 .js」而不是 `build/client`：
 * 前者是真正随商品页下发到顾客浏览器的运行时（受 P2 约束），
 * 后者是后台嵌入式 Admin 的产物，受众与体积口径完全不同。
 *
 * 超限即非 0 退出，供 CI / 本地提交前拦截。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { BUNDLE_MAX_GZIP_BYTES } from "../app/perf-limits";

const ASSETS_DIR = join(
    process.cwd(),
    "extensions",
    "tablely-order-table",
    "assets",
);

function kb(bytes: number): string {
    return `${(bytes / 1024).toFixed(2)} KB`;
}

if (!existsSync(ASSETS_DIR)) {
    console.error(`check-bundle 失败：找不到目录 ${ASSETS_DIR}`);
    process.exit(1);
}

const files = readdirSync(ASSETS_DIR)
    .filter((name) => name.endsWith(".js"))
    .sort();

if (files.length === 0) {
    console.error(
        `check-bundle 失败：${ASSETS_DIR} 下没有 .js 资产，P2 断言将失去意义`,
    );
    process.exit(1);
}

const rows: string[] = [];
let totalGzip = 0;

for (const file of files) {
    const source = readFileSync(join(ASSETS_DIR, file));
    const gzipped = gzipSync(source).byteLength;
    totalGzip += gzipped;
    rows.push(
        `  ${file.padEnd(20)} raw ${kb(source.byteLength).padStart(9)}   gzip ${kb(gzipped).padStart(9)}`,
    );
}

console.log("店面 JS bundle 体积：");
for (const row of rows) console.log(row);
console.log(
    `  合计 gzip ${kb(totalGzip)} / P2 上限 ${kb(BUNDLE_MAX_GZIP_BYTES)}`,
);

if (totalGzip > BUNDLE_MAX_GZIP_BYTES) {
    console.error(
        `\ncheck-bundle 失败：合计 ${kb(totalGzip)} 超过 P2 上限 ${kb(BUNDLE_MAX_GZIP_BYTES)}`,
    );
    process.exit(1);
}

console.log("check-bundle 通过：店面 JS 在 P2 上限内");