/**
 * CSV 生成器与解析器（M13 / Y16 / §15.5–15.6）—— **服务端专用**
 *
 * 硬约束（§15.6）：
 *   · **模板与导出共用同一个生成器** —— `CSV_COLUMNS` 是列头的唯一真源，
 *     任何地方都不得再手写列头；`toImportCsv` 是唯一的 CSV 生产者；
 *   · **列头冻结**：只允许在末尾追加，不改名、不删除、不本地化（`en` 固定）；
 *     导入时列头不匹配**整体报错**，绝不静默错列；
 *   · **RFC4180 转义**：值中含逗号 / 双引号 / 换行时加引号并把 `"` 转义为 `""`；
 *   · **UTF-8 带 BOM**：否则 Excel 打开中文乱码；
 *   · 上限 P6（1000 行 / 1 MB）由 `perf-limits.ts` 的 `checkCsvLimits` 判定。
 *
 * 本模块只做「字符串 ⇄ 行」与「纯格式校验」，**不碰 Admin API**（变体匹配在调用方）。
 */

import { CSV_COLUMNS as COLUMNS } from "../csv-columns";

/**
 * 列头唯一真源（§15.5；**只允许在末尾追加**，不改名 / 不删除 / 不本地化）。
 * 真源放在客户端安全的 `csvColumns.ts`，便于 UI 与单测在不引入 server-only 的前提下引用。
 */
export const CSV_COLUMNS = COLUMNS;
export type CsvColumn = (typeof CSV_COLUMNS)[number];

/** 列头行（顺序即 `CSV_COLUMNS`，`en` 固定） */
export const CSV_HEADER: readonly string[] = CSV_COLUMNS;

/** 模板示例行（首列固定为 `EXAMPLE-SKU-DELETE-ME`，避免商家误当真实数据） */
export const CSV_TEMPLATE_ROW: Record<CsvColumn, string> = {
    sku: "EXAMPLE-SKU-DELETE-ME",
    variant_id: "",
    product_title: "Example product",
    variant_title: "Example variant",
    quantity: "10",
    min_qty: "5",
    max_qty: "100",
    step_qty: "5",
    order_min_amount: "1000.00",
    tier_qty: "10|50",
    tier_price: "9.90|8.90",
    tier_percent: "",
};

/** 一行 CSV 数据（列名 → 原始单元格文本；缺列按空串） */
export type CsvDataRow = Partial<Record<CsvColumn, string>>;

/* ============================== 生成 ============================== */

/**
 * 单元格转义（RFC4180）：含 `,` / `"` / CR / LF 时整体加引号，内部 `"` → `""`。
 * 不含这些字符时原样输出，保持导出文件可读。
 */
export function escapeCsvField(value: unknown): string {
    const text = value === null || value === undefined ? "" : String(value);
    if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
}

/**
 * 由「行对象数组」生成 CSV 文本（**唯一生产者**）。
 *
 * 行对象的键即列名（`CSV_COLUMNS`）；未提供的列输出空串。
 * 输出**带 UTF-8 BOM**，换行用 CRLF（Excel 兼容最好）。
 */
export function toImportCsv(rows: CsvDataRow[]): string {
    const lines: string[] = [CSV_HEADER.map(escapeCsvField).join(",")];
    for (const row of rows) {
        lines.push(
            CSV_COLUMNS.map((column) => escapeCsvField(row[column] ?? "")).join(","),
        );
    }
    return `\uFEFF${lines.join("\r\n")}\r\n`;
}

/**
 * 错误清单 CSV：在标准列头**末尾追加 `error` 列**（§15.6），
 * 其余列原样回填原始值，便于商家对照修改。仍走同一个生成器（列头同源）。
 */
export function toErrorCsv(
    rows: (CsvDataRow & { error?: string })[],
): string {
    const header = [...CSV_HEADER, "error"];
    const lines: string[] = [header.map(escapeCsvField).join(",")];
    for (const row of rows) {
        lines.push(
            [...CSV_COLUMNS.map((column) => escapeCsvField(row[column] ?? "")), escapeCsvField(row.error ?? "")].join(","),
        );
    }
    return `\uFEFF${lines.join("\r\n")}\r\n`;
}

/* ============================== 解析 ============================== */

/**
 * 解析 CSV 文本为「行 × 单元格」矩阵（RFC4180）。
 *
 * 支持：引号包裹、字段内逗号 / 换行 / `""` 转义、CRLF / LF 混用、结尾 BOM。
 * **不做类型转换**，原样返回字符串，校验交给调用方（便于逐行报错）。
 */
export function parseCsv(input: string): string[][] {
    const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
    const rows: string[][] = [];
    let row: string[] = [];
    let field = "";
    let inQuotes = false;

    for (let i = 0; i < text.length; i += 1) {
        const char = text[i];
        if (inQuotes) {
            if (char === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i += 1;
                } else {
                    inQuotes = false;
                }
            } else {
                field += char;
            }
            continue;
        }
        if (char === '"') {
            inQuotes = true;
        } else if (char === ",") {
            row.push(field);
            field = "";
        } else if (char === "\n") {
            row.push(field);
            rows.push(row);
            row = [];
            field = "";
        } else if (char === "\r") {
            // CRLF：吃掉后面的 \n（单独 \r 也当行结束）
            if (text[i + 1] === "\n") i += 1;
            row.push(field);
            rows.push(row);
            row = [];
            field = "";
        } else {
            field += char;
        }
    }
    // 收尾：最后一行没有换行符时补上；完全空文件不产生空行
    if (field !== "" || row.length > 0) {
        row.push(field);
        rows.push(row);
    }
    return rows;
}

/** 矩阵 → 行对象数组（按列头映射；列数不足补空串） */
export function rowsFromMatrix(
    header: string[],
    matrix: string[][],
): CsvDataRow[] {
    return matrix.map((cells) => {
        const row: CsvDataRow = {};
        header.forEach((column, index) => {
            if ((CSV_COLUMNS as readonly string[]).includes(column)) {
                row[column as CsvColumn] = cells[index] ?? "";
            }
        });
        return row;
    });
}

/**
 * 列头校验（§15.6 硬约束）：**必须与 `CSV_HEADER` 完全一致**（顺序 + 名称）。
 * 返回 null 表示通过，否则返回可读原因（调用方整体拒绝，不做静默容错）。
 */
export function csvHeaderError(header: string[]): string | null {
    const normalized = header.map((cell) => cell.trim().replace(/^\uFEFF/, ""));
    if (normalized.length !== CSV_HEADER.length) return "csv.err.headerMismatch";
    for (let i = 0; i < CSV_HEADER.length; i += 1) {
        if (normalized[i] !== CSV_HEADER[i]) return "csv.err.headerMismatch";
    }
    return null;
}

/* ============================== 单元格解析 ============================== */

/** 竖线分隔的多值单元格 → 去空串数组（`"5|10|20"` → `["5","10","20"]`） */
export function splitListCell(value: string | undefined): string[] {
    if (!value) return [];
    return value
        .split("|")
        .map((part) => part.trim())
        .filter((part) => part !== "");
}

/** 空 → null；否则必须是 ≥ 1 的整数（否则返回 undefined 表示非法） */
export function parsePositiveIntCell(value: string | undefined): number | null | undefined {
    const text = (value ?? "").trim();
    if (text === "") return null;
    if (!/^\d+$/.test(text)) return undefined;
    const parsed = Number(text);
    if (!Number.isFinite(parsed) || parsed < 1) return undefined;
    return parsed;
}

/** 空 → null；否则必须是 0–100 的有限数 */
export function parsePercentCell(value: string | undefined): number | null | undefined {
    const text = (value ?? "").trim();
    if (text === "") return null;
    const parsed = Number(text);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100) return undefined;
    return parsed;
}

/** 空 → null；否则必须是非负有限数（金额，十进制字符串） */
export function parseAmountCell(value: string | undefined): string | null | undefined {
    const text = (value ?? "").trim();
    if (text === "") return null;
    const parsed = Number(text);
    if (!Number.isFinite(parsed) || parsed < 0) return undefined;
    return text;
}