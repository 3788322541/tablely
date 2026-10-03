/**
 * Tablely 后台界面 i18n（7 语：en / zh-CN / zh-TW / es / fr / de / ja）
 *
 * 语言集与已上线的 Attributly / Linkly 保持一致（同为 en/zh-CN/zh-TW/es/fr/de/ja），
 * 这样 App Store listing 的 Languages 字段、后台 UI、脚本可三处对齐。
 *
 * 文案拆分在 ./locales/*.json，改文案只动 JSON；本文件只负责运行时解析。
 * 约定：新增 key 时七语必须同时补齐（scripts/check-i18n.ts 校验 key 集合一致）。
 */

import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";
import zhTW from "./locales/zh-TW.json";
import es from "./locales/es.json";
import fr from "./locales/fr.json";
import de from "./locales/de.json";
import ja from "./locales/ja.json";

export type TFunc = (
    key: string,
    vars?: Record<string, string | number>,
) => string;

type Dict = Record<string, string>;

export const LOCALES = ["en", "zh-CN", "zh-TW", "es", "fr", "de", "ja"] as const;

export type Locale = (typeof LOCALES)[number];

const DICTS: Record<Locale, Dict> = {
    en,
    "zh-CN": zhCN,
    "zh-TW": zhTW,
    es,
    fr,
    de,
    ja,
};

/** 把 Shopify 传来的 locale（en / zh-CN / zh-TW / ja…）归一化到支持的语言 */
export function resolveLocale(input: string | null | undefined): Locale {
    if (!input) return "en";
    const raw = input.trim();
    if ((LOCALES as readonly string[]).includes(raw)) return raw as Locale;

    const lower = raw.toLowerCase();
    // 繁体：zh-TW / zh-HK / zh-MO，以及 zh-Hant（含 zh-Hant-TW 这类带子标签的写法）
    if (lower.startsWith("zh")) {
        return /^zh-(tw|hk|mo)|hant/.test(lower) ? "zh-TW" : "zh-CN";
    }
    const base = lower.split("-")[0];
    if ((LOCALES as readonly string[]).includes(base)) return base as Locale;
    return "en";
}

/**
 * 取 Accept-Language 里权重最高的一个标签。
 *
 * 该头天然是逗号分隔的候选列表（`zh-TW,zh-Hant;q=0.9,zh;q=0.8`），
 * 整串直接丢给 resolveLocale 会把它当成一个语种——简体判断恰好命中
 * 「以 zh 开头」，于是繁体用户被兜底成简体。这里先按 q 挑出首选标签再归一化。
 */
function topLanguageTag(header: string | null): string | null {
    if (!header) return null;
    let best: { tag: string; q: number } | null = null;
    for (const part of header.split(",")) {
        const [tag = "", ...params] = part.trim().split(";");
        const name = tag.trim();
        if (!name) continue;
        const qParam = params.map((param) => param.trim()).find((param) => param.startsWith("q="));
        const q = qParam ? Number.parseFloat(qParam.slice(2)) : 1;
        if (!Number.isFinite(q) || q <= 0) continue;
        if (!best || q > best.q) best = { tag: name, q };
    }
    return best?.tag ?? null;
}

/**
 * 解析当前请求的语言：优先 URL 上的 `locale` 参数（Shopify 首次加载嵌入应用时附带），
 * 缺失时回退到 App Bridge 注入的 `Accept-Language` 头。
 *
 * 为什么需要回退：App Bridge v4 的客户端导航走 `history.pushState`，
 * 只保留 pathname + search，**不会带上首次加载时的 locale 参数**
 * （其 fetch 拦截会给同源请求补 `Authorization` / `X-Requested-With` / `Accept-Language`）。
 * 因此只读 URL 参数会导致「点一次导航后所有页面回到英文」。
 */
export function localeFromRequest(request: Request): Locale {
    const fromParam = new URL(request.url).searchParams.get("locale");
    if (fromParam) return resolveLocale(fromParam);
    return resolveLocale(topLanguageTag(request.headers.get("accept-language")));
}

/** 缺 key 回退英文，再缺返回 key 本身 */
export function getT(locale: Locale): TFunc {
    const dict = DICTS[locale] ?? en;
    return (key, vars) => {
        const template = dict[key] ?? (en as Dict)[key] ?? key;
        if (!vars) return template;
        return template.replace(/\{(\w+)\}/g, (match, name: string) =>
            name in vars ? String(vars[name]) : match,
        );
    };
}

export const DICTIONARIES = DICTS;