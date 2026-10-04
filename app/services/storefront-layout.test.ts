/**
 * 店面布局 / 价格 / 缺货策略的静态断言（M6 布局；M7 含税·折扣标·缺货三策略）
 *
 * 主题扩展的 Liquid 与 CSS 无法被 vitest 直接渲染（跨域店面 + 无头浏览器禁用），
 * 故沿用本项目既定的**文本断言**取证方式（同「CSS 里不出现 `!important`」）：
 *   · 四种布局确实各有 DOM 分支，且**只有一张原生表单**（无 JS 多行兜底，§十二 验收 1/9）；
 *   · 矩阵是**语义化表格**（`th[scope=row]`），且不满足 2 轴时降级为表格（§1.4 #3）；
 *   · 手机端紧凑列按**列优先级**逐级收起（#18），CSS 无 `!important`（§十二 验收 15）；
 *   · **M7**：含税标签以 `cart.taxes_included` 为真源（验收 #5）、折扣标基准 = 当前价
 *     （#15）、缺货三策略 gray/hide/backorder（#13）—— 见各 describe。
 *
 * 真实浏览器行为（布局渲染、键盘走查）属 `e2e`，见 §十二 M5/M6/M7 落地状态。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const EXT = join(process.cwd(), "extensions", "tablely-order-table");

function read(relative: string): string {
    return readFileSync(join(EXT, relative), "utf8");
}

const markup = read("snippets/table-markup.liquid");
const qtySnippet = read("snippets/table-qty.liquid");
const priceSnippet = read("snippets/table-price.liquid");
const block = read("blocks/order-table.liquid");
const css = read("assets/tablely.css");
/** 去掉 CSS 注释后再断言：文件头注释本身会提到「不写 !important」（§十二 验收 15） */
const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** 店面 7 语 locale 文件名（`en` 为 `en.default.json`，见 scripts/check-i18n.ts） */
const LOCALE_FILES = [
    "en.default",
    "zh-CN",
    "zh-TW",
    "es",
    "fr",
    "de",
    "ja",
] as const;

describe("四种布局（同一份数据，零额外请求）", () => {
    it("表格 / 网格 / 列表 / 矩阵都有各自的渲染分支", () => {
        expect(markup).toContain("tly_layout == 'grid' or tly_layout == 'list'");
        expect(markup).toContain("tly_layout == 'matrix'");
        expect(markup).toContain("tablely-items--{{ tly_layout }}");
        // 表格是默认分支（也是矩阵的降级目标）
        expect(markup).toContain('class="tablely-table"');
    });

    it("四种布局共用**同一张**原生表单（无 JS 多行提交，§十二 验收 1）", () => {
        expect(markup.match(/<form\b/g)?.length).toBe(1);
        expect(markup).toContain("{{ routes.cart_add_url }}");
        // 多行输入的 name 在共用片段里（四种布局都经它输出）
        expect(qtySnippet).toContain("items[{{ idx }}][id]");
        expect(qtySnippet).toContain("items[{{ idx }}][quantity]");
    });

    it("网格 / 列表复用同一套卡片 DOM，仅修饰类不同", () => {
        expect(markup).toContain("tablely-item--{{ tly_layout }}");
        expect(css).toContain(".tablely-items--grid");
        expect(css).toContain(".tablely-items--list");
    });
});

describe("矩阵：2 个 option 轴 + 语义化表头（B14 / §1.4 #3）", () => {
    it("矩阵以语义化 <table> 渲染，行头用 th[scope=row]", () => {
        expect(markup).toContain('class="tablely-table tablely-matrix"');
        expect(markup).toContain('scope="row"');
        expect(markup).toContain('scope="col"');
    });

    it("契约里 matrix 为 null（非 2 轴）时自动降级为表格（§十三 C9）", () => {
        expect(block).toContain("tly_tbl.matrix == nil");
        expect(block).toContain("assign tly_layout = 'table'");
    });

    it("矩阵按 cells 的 x/y 坐标反查变体，格子缺失不伪造", () => {
        expect(markup).toContain("tly_mx.cells | where: 'x'");
        expect(markup).toContain("| where: 'y'");
        expect(markup).toContain("tablely-matrix-empty");
    });
});

describe("手机端紧凑列（#18，Free）与样式底线", () => {
    it("窄屏按优先级逐级收起：先 SKU/ID，再库存列", () => {
        expect(css).toMatch(/@media screen and \(max-width: 600px\)[\s\S]*?\.tablely-sku/);
        expect(css).toMatch(
            /@media screen and \(max-width: 480px\)[\s\S]*?data-tablely-layout='table'[\s\S]*?\.tablely-cell-stock/,
        );
    });

    it("CSS 不含 !important（§十二 验收 15）", () => {
        expect(cssCode).not.toContain("!important");
    });

    it("增强控件在 JS 就绪前一律不显示（无 JS 不留死按钮）", () => {
        expect(css).toMatch(/\.tablely-action\s*\{\s*display:\s*none/);
        expect(css).toContain("[data-tablely-ready='true'] .tablely-action");
    });
});

describe("含税 / 不含税标签（M7 / §1.4 #14；验收 #5）", () => {
    it("以 cart.taxes_included 为真源，缺失时退回店铺级 taxDisplay", () => {
        expect(markup).toContain("cart.taxes_included");
        expect(markup).toContain("tly_settings.taxDisplay");
        expect(markup).toContain("'table.vatIncl'");
        expect(markup).toContain("'table.vatExcl'");
    });

    it("价格列头（表格 + 网格/列表）改用含税标签，不再固定 'table.col.price'", () => {
        expect(markup).toContain("{{ tly_price_label | t }}");
        expect(markup).not.toContain("'table.col.price' | t");
    });

    it("7 语都提供 vatExcl / vatIncl 且无占位符", () => {
        for (const file of LOCALE_FILES) {
            const dict = JSON.parse(read(`locales/${file}.json`)) as {
                table: Record<string, string>;
            };
            for (const key of ["vatExcl", "vatIncl"]) {
                expect(dict.table[key], `${file} 缺 ${key}`).toBeTruthy();
                expect(dict.table[key]).not.toMatch(/\{\{/);
            }
        }
    });
});

describe("折扣标（M7 / §1.4 #15）", () => {
    it("基准 = 变体当前价，仅在 compare_at_price 更高时输出划线原价与百分比", () => {
        expect(priceSnippet).toContain("v.compare_at_price > v.price");
        expect(priceSnippet).toContain("tablely-price-was");
        expect(priceSnippet).toContain("tablely-price-badge");
        expect(priceSnippet).toContain("100 | minus");
    });

    it("四种布局都经同一价格片段输出（无重复实现）", () => {
        expect((markup.match(/render 'table-price'/g) ?? []).length).toBeGreaterThanOrEqual(3);
    });

    it("折扣标样式在 CSS 内且全文不含 !important", () => {
        expect(css).toContain(".tablely-price-badge");
        expect(cssCode).not.toContain("!important");
    });
});

describe("缺货三策略（M7 / §1.4 #13）", () => {
    it("从店铺级设置读取，默认 gray", () => {
        expect(markup).toContain("tly_settings.outOfStock");
        expect(markup).toContain("default: 'gray'");
    });

    it("hide 整行不渲染；backorder 让缺货行可下单（force 行不下发 data-stock）", () => {
        expect(markup).toContain("tly_oos == 'hide' and v_ok == false");
        expect(markup).toContain("tly_oos == 'backorder'");
        expect(markup).toContain("v_force == false");
    });

    it("gray 仍是默认路径：不可售行保留置灰类与 data-soldout", () => {
        expect(markup).toContain('data-soldout="true"');
        expect(markup).toContain("tablely-row--soldout");
    });
});
