/**
 * 七语 key 一致性校验（npm run check-i18n）
 *
 * 校验两类文案，规则相同（key 集合一致 / 占位符一致 / 无空串），仅占位符语法不同：
 *   ① 后台文案：`app/i18n.ts` 的 `DICTIONARIES`，占位符 `{n}`
 *   ② 店面文案：`extensions/tablely-order-table/locales/*.json`，占位符 `{{ n }}`
 *      （主题 locale 文件的语法与后台不同；`name` 是扩展名元数据，只出现在
 *        `en.default.json`，不参与 key 比对）
 *
 * 有任何不一致即以非 0 退出，用于 CI / 本地提交前检查。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { DICTIONARIES, LOCALES } from "../app/i18n";

type Dict = Record<string, string>;

let errors = 0;

function report(message: string) {
    errors += 1;
    console.error(`  ✗ ${message}`);
}

/** 后台文案占位符：{n} */
function backendPlaceholders(text: string): string[] {
    const found = text.match(/\{(\w+)\}/g) ?? [];
    return [...new Set(found)].sort();
}

/** 店面文案占位符：{{ n }}（主题 locale 文件语法） */
function storefrontPlaceholders(text: string): string[] {
    const found = text.match(/\{\{\s*(\w+)\s*\}\}/g) ?? [];
    return [...new Set(found.map((token) => token.replace(/[{}\s]/g, "")))].sort();
}

type CheckOptions = {
    label: string;
    baseName: string;
    locales: readonly string[];
    dictOf: (locale: string) => Dict | undefined;
    placeholders: (text: string) => string[];
    /** 这些 key 是元数据（如扩展名 `name`），只存在于基准语言，不参与比对 */
    metaKeys?: readonly string[];
};

/** 逐语种比对 key 集合、占位符与空串；返回通过与否（用于最终汇总） */
function checkSet(options: CheckOptions): { ok: boolean; keyCount: number } {
    const metaKeys = new Set(options.metaKeys ?? []);
    const baseRaw = options.dictOf(options.baseName);
    if (!baseRaw) {
        console.error(`\n[${options.label}]`);
        report(`基准语言 ${options.baseName} 的字典缺失`);
        return { ok: false, keyCount: 0 };
    }

    const base: Dict = {};
    for (const [key, value] of Object.entries(baseRaw)) {
        if (!metaKeys.has(key)) base[key] = value;
    }
    const baseKeys = Object.keys(base).sort();

    let ok = true;

    for (const locale of options.locales) {
        const raw = options.dictOf(locale);
        if (!raw) {
            console.error(`\n[${options.label} · ${locale}]`);
            report("字典缺失");
            ok = false;
            continue;
        }

        const dict: Dict = {};
        for (const [key, value] of Object.entries(raw)) {
            if (!metaKeys.has(key)) dict[key] = value;
        }

        const keys = Object.keys(dict).sort();
        const missing = baseKeys.filter((key) => !(key in dict));
        const extra = keys.filter((key) => !(key in base));

        if (missing.length || extra.length) {
            console.error(`\n[${options.label} · ${locale}]`);
            for (const key of missing) report(`缺少 key: ${key}`);
            for (const key of extra) report(`多余 key: ${key}`);
            ok = false;
            continue;
        }

        const problems: string[] = [];
        for (const key of baseKeys) {
            const value = dict[key];
            if (typeof value !== "string" || !value.trim()) {
                problems.push(`空翻译: ${key}`);
                continue;
            }
            const expected = options.placeholders(base[key]);
            const actual = options.placeholders(value);
            if (expected.join(",") !== actual.join(",")) {
                problems.push(
                    `占位符不一致: ${key}（基准 [${expected.join(", ")}] vs 实际 [${actual.join(", ")}]）`,
                );
            }
        }

        if (problems.length) {
            console.error(`\n[${options.label} · ${locale}]`);
            for (const problem of problems) report(problem);
            ok = false;
        }
    }

    return { ok, keyCount: baseKeys.length };
}

/* ---------------------------- ① 后台文案 ---------------------------- */

const backend = checkSet({
    label: "后台 app/i18n.ts",
    baseName: "en",
    locales: LOCALES,
    dictOf: (locale) => DICTIONARIES[locale as keyof typeof DICTIONARIES] as Dict,
    placeholders: backendPlaceholders,
});

/* ------------------- ② 主题扩展的店面文案（顾客可见） ------------------- */

const EXT_LOCALES_DIR = join(
    process.cwd(),
    "extensions",
    "tablely-order-table",
    "locales",
);

type JsonValue =
    | string
    | number
    | boolean
    | null
    | JsonValue[]
    | { [key: string]: JsonValue };

/**
 * 主题 locale 文件是**嵌套 JSON**（key 本身不能含 `.`，CLI 会报
 * `Key "a.b" contains invalid characters`），这里展开成 `a.b.c` 扁平形式，
 * 与后台 `app/i18n.ts` 的扁平 key 同口径比对。
 */
function flattenDict(value: JsonValue, prefix = "", out: Dict = {}): Dict {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const [key, child] of Object.entries(value)) {
            flattenDict(
                child as JsonValue,
                prefix ? `${prefix}.${key}` : key,
                out,
            );
        }
    } else if (typeof value === "string") {
        out[prefix] = value;
    }
    return out;
}

function extensionDict(locale: string): Dict | undefined {
    const file = locale === "en" ? "en.default.json" : `${locale}.json`;
    const path = join(EXT_LOCALES_DIR, file);
    if (!existsSync(path)) return undefined;
    try {
        return flattenDict(JSON.parse(readFileSync(path, "utf8")) as JsonValue);
    } catch (error) {
        report(`[店面文案] ${file} 不是合法 JSON：${(error as Error).message}`);
        return undefined;
    }
}

const storefront = checkSet({
    label: "主题扩展 locales",
    baseName: "en",
    locales: LOCALES,
    dictOf: extensionDict,
    placeholders: storefrontPlaceholders,
    metaKeys: ["name"],
});

/* ------------------------------- 汇总 ------------------------------- */

if (errors > 0 || !backend.ok || !storefront.ok) {
    console.error(
        `\ncheck-i18n 失败：共 ${errors} 个问题（后台 en 基准 ${backend.keyCount} key，店面 en 基准 ${storefront.keyCount} key）`,
    );
    process.exit(1);
}

console.log(
    `check-i18n 通过：后台 ${LOCALES.length} 语 × ${backend.keyCount} key；店面 ${LOCALES.length} 语 × ${storefront.keyCount} key，全部一致`,
);