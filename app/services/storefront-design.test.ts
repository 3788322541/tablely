/**
 * Design / 隐藏开关的静态断言（M8，§2.8 / §十二 验收 14、15）
 *
 * 与 `storefront-layout.test.ts` 同一取证方式：主题扩展的 Liquid / CSS / JS 无法被
 * vitest 直接渲染（跨域店面 + 无头浏览器禁用），故对**真实文件文本**做断言 ——
 * 这正是 theme check 之外的自动化补充（§十二 M8 验收）。
 *
 * 覆盖：
 *   · **验收 14 安全兜底**：`table-style` 只在 `tly_show = true` 分支内被引入，
 *     且隐藏分支自身再判 `hideNative.enabled` —— 表格没渲染 ⇒ 一行不输出 ⇒ 原生加购区绝不隐藏；
 *   · **验收 15 隐藏合规**：不写 `!important`、选择器来自消毒后的契约值、只输出 `display: none`；
 *   · **外观即时生效**：密度 / 字体 / 圆角 / 品牌色以 CSS 变量下发，且判空用 `!= nil`（`0px` 不被吞）；
 *   · **反馈呈现方式**：`data-tablely-feedback` + 浮层 + 读屏不重复播报（B14）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const EXT = join(process.cwd(), "extensions", "tablely-order-table");

function read(relative: string): string {
    return readFileSync(join(EXT, relative), "utf8");
}

/** 去掉 CSS / Liquid 注释后再断言：注释里会提到「不写 !important」等字眼 */
function stripCssComments(code: string): string {
    return code.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** 再去掉 Liquid 注释块（`{% comment %}…{% endcomment %}`） */
function stripLiquidComments(code: string): string {
    return code.replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, "");
}

const block = read("blocks/order-table.liquid");
const styleSnippet = read("snippets/table-style.liquid");
const runtimeSnippet = read("snippets/table-runtime.liquid");
const css = read("assets/tablely.css");
const script = read("assets/tablely.js");

const styleCode = stripLiquidComments(stripCssComments(styleSnippet));
const cssCode = stripCssComments(css);

describe("隐藏开关安全兜底（B1 / §十二 验收 14）", () => {
    it("table-style 只在 tly_show 为真的分支内被引入", () => {
        const showIndex = block.indexOf("{%- if tly_show -%}");
        const renderIndex = block.indexOf("render 'table-style'");
        expect(showIndex).toBeGreaterThan(-1);
        expect(renderIndex).toBeGreaterThan(showIndex);
    });

    it("隐藏分支自身再判 hideNative.enabled（第二道闸）", () => {
        expect(styleSnippet).toContain("tly_settings.hideNative.enabled");
    });

    it("契约缺失（tly_settings 为 nil）时隐藏输出为空", () => {
        // 样式块读 tly_settings.style；tly_settings 为 nil 时 Liquid 输出空，
        // 且隐藏分支同样取不到 hideNative.enabled（nil）→ 不输出
        expect(styleSnippet).toContain("tly_settings.hideNative.enabled");
        expect(styleSnippet).not.toMatch(/hideNative\.enabled\s*\|\s*default/);
    });
});

describe("隐藏实现合规（B1 / §十二 验收 15）", () => {
    it("输出的选择器来自契约值（服务端已消毒），只写 display: none", () => {
        expect(styleSnippet).toContain("{{ tly_settings.hideNative.selector }}");
        expect(styleSnippet).toMatch(
            /\{\{\s*tly_settings\.hideNative\.selector\s*\}\}\s*\{[\s\S]*?display:\s*none;/,
        );
    });

    it("样式片段与 CSS 全文都不含 !important", () => {
        expect(styleCode).not.toContain("!important");
        expect(cssCode).not.toContain("!important");
    });
});

describe("外观下发：CSS 变量驱动，改设置即生效（M8 验收）", () => {
    it("密度映射 0.72 / 1 / 1.35", () => {
        expect(styleSnippet).toContain("tly_density == 'compact'");
        expect(styleSnippet).toContain("0.72");
        expect(styleSnippet).toContain("tly_density == 'comfortable'");
        expect(styleSnippet).toContain("1.35");
    });

    it("字体提供跟随主题 / 系统 / 衬线三档，默认跟随主题", () => {
        expect(styleSnippet).toContain("tly_font == 'system'");
        expect(styleSnippet).toContain("tly_font == 'serif'");
        expect(styleSnippet).toContain("| default: 'inherit'");
    });

    it("圆角 / 品牌色判空用 `!= nil`（0px 是合法值，不能被 default 吞掉）", () => {
        expect(styleSnippet).toContain("tly_style.radius != nil");
        expect(styleSnippet).toContain("tly_style.brandColor != nil");
        expect(styleSnippet).not.toMatch(/tly_style\.radius\s*\|\s*default/);
        expect(styleSnippet).not.toMatch(/tly_style\.brandColor\s*\|\s*default/);
    });

    it("CSS 里品牌色 / 密度都有 currentColor / 1 兜底，且被实际引用", () => {
        expect(css).toContain("--tablely-brand: currentColor;");
        expect(css).toContain("--tablely-density: 1;");
        expect(css).toContain("var(--tablely-density)");
        expect(css).toContain("var(--tablely-brand)");
    });
});

describe("反馈呈现方式（M8 / B14 读屏不重复）", () => {
    it("根节点带上契约里的 feedbackStyle", () => {
        expect(block).toContain('data-tablely-feedback="{{ tly_settings.feedbackStyle | default: \'inline\' }}"');
    });

    it("运行时渲染 aria-hidden 的浮层容器（纯视觉副本）", () => {
        expect(runtimeSnippet).toContain('class="tablely-toast"');
        expect(runtimeSnippet).toContain('data-tablely-toast');
        expect(runtimeSnippet).toContain('aria-hidden="true"');
        expect(runtimeSnippet).toContain("hidden");
    });

    it("toast 模式下行内容器视觉隐藏但保留在可访问性树（不用 display:none）", () => {
        const rule = css.match(
            /\.tablely-root\[data-tablely-feedback='toast'\]\s*\.tablely-feedback\s*\{([\s\S]*?)\}/,
        );
        expect(rule).not.toBeNull();
        expect(rule?.[1]).toContain("clip-path");
        expect(rule?.[1]).not.toContain("display: none");
        expect(css).toContain(".tablely-toast {");
    });

    it("JS 读取 feedbackStyle，并在非 inline 时填浮层", () => {
        expect(script).toContain("settings.feedbackStyle");
        expect(script).toContain("feedbackStyle === 'inline'");
        expect(script).toContain("[data-tablely-toast]");
        expect(script).toContain("tablely-toast--error");
    });
});
