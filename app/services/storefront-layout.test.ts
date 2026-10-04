/**
 * 四种布局的静态断言（M6，§1.4 #3/#18 / §五 可访问性 / §十三 C9）
 *
 * 主题扩展的 Liquid 与 CSS 无法被 vitest 直接渲染（跨域店面 + 无头浏览器禁用），
 * 故沿用本项目既定的**文本断言**取证方式（同「CSS 里不出现 `!important`」）：
 *   · 四种布局确实各有 DOM 分支，且**只有一张原生表单**（无 JS 多行兜底，§十二 验收 1/9）；
 *   · 矩阵是**语义化表格**（`th[scope=row]`），且不满足 2 轴时降级为表格（§1.4 #3）；
 *   · 手机端紧凑列按**列优先级**逐级收起（#18），CSS 无 `!important`（§十二 验收 15）。
 *
 * 真实浏览器行为（布局渲染、键盘走查）属 `e2e`，见 §十二 M5/M6 落地状态。
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
const block = read("blocks/order-table.liquid");
const css = read("assets/tablely.css");
/** 去掉 CSS 注释后再断言：文件头注释本身会提到「不写 !important」（§十二 验收 15） */
const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, "");

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
