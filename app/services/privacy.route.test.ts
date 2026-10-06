/**
 * 公开隐私页路由级单测（M15 / §8.3 / §十二 验收 31）
 *
 * 直接调用 `loader`（不启服务、不连库）并静态读源文件，守住三条红线：
 *   · **公开免鉴权**：源文件不得出现 `authenticate`（审核员与终端客户都要能打开）；
 *   · **不设 cookie**：源文件不得出现 `set-cookie` / Cookie 写入，loader 只读请求；
 *   · **与 §8.1 数据保留总表逐条对应**：7 语下申请=90 天、加购=180 天、报价单=30 天。
 *
 * 放在 `app/services/`（而非 `app/routes/`）：`app/routes/*.test.ts` 会被
 * React Router 的 flatRoutes 当成路由模块打进构建（先例见 appProxy.route.test.ts）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loader } from "../routes/privacy";
import { getT, LOCALES } from "../i18n";

const PRIVACY_SOURCE = readFileSync(
    fileURLToPath(new URL("../routes/privacy.tsx", import.meta.url)),
    "utf8",
);

/** 去掉注释后再做静态红线断言：本文件注释里会引用 `authenticate` / `!important` 等词 */
const PRIVACY_CODE = PRIVACY_SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(
    /^\s*\/\/.*$/gm,
    "",
);

function load(url: string, headers?: Record<string, string>) {
    return loader({ request: new Request(url, { headers }) } as never);
}

describe("loader（GET /privacy）", () => {
    it("公开可访问：不跳转、不鉴权，直接返回 locale", async () => {
        const data = await load("https://tablely.zhenjunit.com/privacy");
        expect(data).toEqual({ locale: "en" });
    });

    it("?locale=ja → 日语（不依赖 shop / host 参数）", async () => {
        const data = await load("https://tablely.zhenjunit.com/privacy?locale=ja");
        expect(data.locale).toBe("ja");
    });

    it("无 locale 参数时回退 Accept-Language（zh-TW 命中繁体）", async () => {
        const data = await load("https://tablely.zhenjunit.com/privacy", {
            "accept-language": "zh-TW,zh-Hant;q=0.9,zh;q=0.8",
        });
        expect(data.locale).toBe("zh-TW");
    });
});

describe("与 §8.1 数据保留总表逐条对应（7 语）", () => {
    it.each(LOCALES)("%s：申请 90 天 / 加购 180 天 / 报价单 30 天", (locale) => {
        const t = getT(locale);
        expect(t("privacy.row.applications.retention")).toContain("90");
        expect(t("privacy.row.events.retention")).toContain("180");
        expect(t("privacy.row.quotes.retention")).toContain("30");
    });

    it.each(LOCALES)("%s：六模块标题齐备（§8.3）", (locale) => {
        const t = getT(locale);
        const keys = [
            "privacy.title",
            "privacy.s1.title",
            "privacy.s2.title",
            "privacy.s3.title",
            "privacy.s4.title",
            "privacy.s5.title",
            "privacy.s6.title",
            "privacy.contact",
        ];
        for (const key of keys) {
            expect(t(key), `${locale} 缺 ${key}`).not.toBe(key);
        }
    });

    it("联系邮箱渲染为 mailto（子处理方与联系方式模块）", () => {
        expect(PRIVACY_SOURCE).toContain("mailto:");
        expect(PRIVACY_SOURCE).toContain("SUPPORT_EMAIL");
    });
});

describe("静态红线：公开页不得鉴权、不得写 cookie", () => {
    it("不含 authenticate / shopify.server", () => {
        expect(PRIVACY_CODE).not.toContain("authenticate");
        expect(PRIVACY_CODE).not.toContain("shopify.server");
    });

    it("不含任何 cookie 写入", () => {
        expect(PRIVACY_CODE.toLowerCase()).not.toContain("set-cookie");
        expect(PRIVACY_CODE).not.toContain("document.cookie");
    });

    it("样式符合项目底线：不写 !important、尺寸用 rem（仅允许 1px 描边）、系统色", () => {
        expect(PRIVACY_CODE).not.toContain("!important");
        // 1px 描边是发丝线，不属于需要随字号缩放的度量；其余尺寸一律用 rem
        expect(PRIVACY_CODE.replace(/1px solid/g, "")).not.toMatch(/\d+px/);
        expect(PRIVACY_CODE).toContain("colorScheme");
    });
});
