/**
 * 分销商申请表单的**字段模板 + 校验**（M11）—— **客户端安全**（零 server-only 依赖）
 *
 * 为什么单独一份（与 `app/design-choices.ts` 同因）：`applications.server.ts` 是
 * server-only 模块（依赖 db.server），而 `proxy.apply.tsx` 的 HTML 由服务端生成；
 * 但字段白名单同时要被**服务端二次校验**与**后台审批页展示**复用，放这里做唯一真源，
 * 避免「表单能填、后端不认」或两处枚举分叉。
 *
 * 契约：默认 13 字段模板照用方案 §15.1 的表（字段顺序一致）；Pro 的字段设计器（可增删改）
 * 不在本轮（M11），须在方案 §十四如实记录为后续里程碑。
 *
 * 国家列表用 ISO 3166-1 alpha-2，**显示名走 `Intl.DisplayNames`**（7 语免维护，
 * 无需为 200+ 国家各写 7 份翻译）。
 */

/* ============================== 字段模板 ============================== */

export type ApplicationFieldType =
    | "text"
    | "tel"
    | "email"
    | "url"
    | "select"
    | "multi"
    | "radio"
    | "textarea"
    | "checkbox";

export type ApplicationField = {
    /** payload 的键（也是表单控件的 name） */
    key: string;
    type: ApplicationFieldType;
    required: boolean;
    /** 标签 i18n key，形如 `apply.field.firstName` */
    labelKey: string;
    maxLength?: number;
    /** 可选值白名单（select / multi / radio） */
    options?: readonly string[];
    /** 选项文案 i18n key 前缀，形如 `apply.opt.business` → `apply.opt.business.jewelry` */
    optionKeyPrefix?: string;
    /** 字段下方说明 i18n key（可选） */
    hintKey?: string;
};

/** 主营业务（§15.1 #8） */
export const BUSINESS_TYPES = [
    "jewelry",
    "apparel",
    "beauty",
    "home",
    "electronics",
    "other",
] as const;

/** 销售渠道（§15.1 #10） */
export const CHANNELS = [
    "own_store",
    "amazon",
    "ebay",
    "tiktok",
    "offline",
    "social",
    "other",
] as const;

/** 预计月采购量（§15.1 #11）—— 单位（件 / 金额）由商家自行约定 */
export const MONTHLY_VOLUMES = ["lt1000", "mid", "high", "gt20000"] as const;

/** 是否代理过同类品牌（§15.1 #9） */
export const BRAND_EXPERIENCE = ["yes", "no"] as const;

/** 国家 / 地区：ISO 3166-1 alpha-2（§15.1 #4「内置国家列表」） */
export const COUNTRIES: readonly string[] = [
    "AD", "AE", "AF", "AG", "AI", "AL", "AM", "AO", "AR", "AT", "AU", "AW", "AX",
    "AZ", "BA", "BB", "BD", "BE", "BF", "BG", "BH", "BI", "BJ", "BL", "BM", "BN",
    "BO", "BQ", "BR", "BS", "BT", "BW", "BY", "BZ", "CA", "CC", "CD", "CF", "CG",
    "CH", "CI", "CK", "CL", "CM", "CN", "CO", "CR", "CU", "CV", "CW", "CX", "CY",
    "CZ", "DE", "DJ", "DK", "DM", "DO", "DZ", "EC", "EE", "EG", "EH", "ER", "ES",
    "ET", "FI", "FJ", "FK", "FM", "FO", "FR", "GA", "GB", "GD", "GE", "GF", "GG",
    "GH", "GI", "GL", "GM", "GN", "GP", "GQ", "GR", "GT", "GU", "GW", "GY", "HK",
    "HN", "HR", "HT", "HU", "ID", "IE", "IL", "IM", "IN", "IO", "IQ", "IR", "IS",
    "IT", "JE", "JM", "JO", "JP", "KE", "KG", "KH", "KI", "KM", "KN", "KR", "KW",
    "KY", "KZ", "LA", "LB", "LC", "LI", "LK", "LR", "LS", "LT", "LU", "LV", "LY",
    "MA", "MC", "MD", "ME", "MF", "MG", "MH", "MK", "ML", "MM", "MN", "MO", "MP",
    "MQ", "MR", "MS", "MT", "MU", "MV", "MW", "MX", "MY", "MZ", "NA", "NC", "NE",
    "NF", "NG", "NI", "NL", "NO", "NP", "NR", "NU", "NZ", "OM", "PA", "PE", "PF",
    "PG", "PH", "PK", "PL", "PM", "PN", "PR", "PS", "PT", "PW", "PY", "QA", "RE",
    "RO", "RS", "RU", "RW", "SA", "SB", "SC", "SD", "SE", "SG", "SH", "SI", "SJ",
    "SK", "SL", "SM", "SN", "SO", "SR", "SS", "ST", "SV", "SX", "SY", "SZ", "TC",
    "TD", "TF", "TG", "TH", "TJ", "TK", "TL", "TM", "TN", "TO", "TR", "TT", "TV",
    "TW", "TZ", "UA", "UG", "UM", "US", "UY", "UZ", "VA", "VC", "VE", "VG", "VI",
    "VN", "VU", "WF", "WS", "YE", "YT", "ZA", "ZM", "ZW",
];

/** 默认 13 字段模板（顺序 = §15.1 表顺序，也是表单渲染顺序） */
export const APPLICATION_FIELDS: readonly ApplicationField[] = [
    { key: "firstName", type: "text", required: true, labelKey: "apply.field.firstName", maxLength: 40 },
    { key: "lastName", type: "text", required: true, labelKey: "apply.field.lastName", maxLength: 40 },
    { key: "phone", type: "tel", required: true, labelKey: "apply.field.phone" },
    {
        key: "country",
        type: "select",
        required: true,
        labelKey: "apply.field.country",
        options: COUNTRIES,
    },
    { key: "email", type: "email", required: true, labelKey: "apply.field.email" },
    { key: "company", type: "text", required: true, labelKey: "apply.field.company", maxLength: 80 },
    {
        key: "website",
        type: "url",
        required: false,
        labelKey: "apply.field.website",
        hintKey: "apply.hint.website",
    },
    {
        key: "businessTypes",
        type: "multi",
        required: true,
        labelKey: "apply.field.businessTypes",
        options: BUSINESS_TYPES,
        optionKeyPrefix: "apply.opt.business",
    },
    {
        key: "brandExperience",
        type: "radio",
        required: true,
        labelKey: "apply.field.brandExperience",
        options: BRAND_EXPERIENCE,
        optionKeyPrefix: "apply.opt.experience",
    },
    {
        key: "channels",
        type: "multi",
        required: true,
        labelKey: "apply.field.channels",
        options: CHANNELS,
        optionKeyPrefix: "apply.opt.channel",
    },
    {
        key: "monthlyVolume",
        type: "select",
        required: false,
        labelKey: "apply.field.monthlyVolume",
        options: MONTHLY_VOLUMES,
        optionKeyPrefix: "apply.opt.volume",
    },
    {
        key: "message",
        type: "textarea",
        required: false,
        labelKey: "apply.field.message",
        maxLength: 500,
    },
    {
        key: "privacyConsent",
        type: "checkbox",
        required: true,
        labelKey: "apply.field.privacyConsent",
    },
];

/** 表单控件 name（也是 payload 键）→ 字段定义 */
export const APPLICATION_FIELD_MAP: Readonly<Record<string, ApplicationField>> =
    Object.fromEntries(APPLICATION_FIELDS.map((field) => [field.key, field]));

/* ============================== 展示辅助 ============================== */

/** ISO 国家码 → 当前语言的显示名；未知码 / 运行时不支持时回退为码本身 */
export function countryName(code: string, locale: string): string {
    try {
        const names = new Intl.DisplayNames([locale], { type: "region" });
        return names.of(code) ?? code;
    } catch {
        return code;
    }
}

/* ============================== 校验 ============================== */

/** 归一化后的申请内容（写入 `WholesaleApplication.payload`） */
export type ApplicationPayload = {
    firstName: string;
    lastName: string;
    phone: string;
    country: string;
    email: string;
    company: string;
    website: string | null;
    businessTypes: string[];
    brandExperience: string;
    channels: string[];
    monthlyVolume: string | null;
    message: string | null;
    /** 隐私同意留痕（合规留证，恒定 true） */
    privacyConsent: boolean;
    /** 提交时顾客语言，供商家回访参考 */
    locale: string;
};

/** 表单原始值（未校验）；`multi` 为数组，`checkbox` 为布尔 */
export type ApplicationValues = Record<string, string | string[] | boolean>;

/** 字段名 → i18n key（错误提示就地渲染在该字段下方） */
export type ApplicationErrors = Record<string, string>;

export type ApplicationReview = {
    payload: ApplicationPayload | null;
    errors: ApplicationErrors;
};

/** 把 FormData 归一成 `ApplicationValues`（缺字段取空值，不抛错） */
export function valuesFromFormData(formData: FormData): ApplicationValues {
    const values: ApplicationValues = {};
    for (const field of APPLICATION_FIELDS) {
        if (field.type === "multi") {
            values[field.key] = formData.getAll(field.key).map((value) => String(value));
        } else if (field.type === "checkbox") {
            values[field.key] = formData.get(field.key) !== null;
        } else {
            values[field.key] = String(formData.get(field.key) ?? "");
        }
    }
    return values;
}

/** 单行文本 / 电话 / 邮箱等的长度上限（防灌库，比 §15.1 的字段约束更宽松地兜底） */
const EMAIL_MAX = 254;
const PHONE_MAX = 40;
const MESSAGE_MAX = 500;

const TEXT_MAX: Record<string, number> = {
    firstName: 40,
    lastName: 40,
    company: 80,
    website: 500,
};

/** RFC 简版：非空 local@domain.tld（够用且不会误杀常见合法地址） */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const URL_RE = /^https?:\/\/\S+$/i;

const asText = (value: unknown): string =>
    typeof value === "string" ? value.trim() : "";

const asList = (value: unknown): string[] =>
    Array.isArray(value)
        ? value.map((item) => String(item).trim()).filter(Boolean)
        : [];

/** 白名单过滤，去重保序（不信任前端传来的选项值） */
function pickOptions(values: string[], allowed: readonly string[]): string[] {
    const allow = new Set<string>(allowed);
    return [...new Set(values.filter((value) => allow.has(value)))];
}

/**
 * 校验申请（纯函数）：合法返回 `payload`，非法返回逐字段 i18n key。
 *
 * 前后端**共用同一份**：客户端提交前拦截（好体验），服务端落库前再跑一遍（好安全，§8.2 B）。
 * 校验失败时不返回 `payload`，调用方据此拒绝落库。
 */
export function validateApplication(
    values: ApplicationValues,
    locale: string,
): ApplicationReview {
    const errors: ApplicationErrors = {};

    const text = (key: string): string => {
        const raw = asText(values[key]);
        const max = TEXT_MAX[key];
        if (raw && max && raw.length > max) errors[key] = "error.applicationTooLong";
        return raw;
    };

    const firstName = text("firstName");
    if (!firstName) errors.firstName = "error.applicationRequired";

    const lastName = text("lastName");
    if (!lastName) errors.lastName = "error.applicationRequired";

    const phone = asText(values.phone);
    const digits = phone.replace(/\D/g, "");
    if (!phone) {
        errors.phone = "error.applicationRequired";
    } else if (
        phone.length > PHONE_MAX ||
        digits.length < 6 ||
        digits.length > 20 ||
        !/^[+\d][\d\s\-().]*$/.test(phone)
    ) {
        errors.phone = "error.applicationPhone";
    }

    const country = asText(values.country);
    if (!country) {
        errors.country = "error.applicationRequired";
    } else if (!COUNTRIES.includes(country)) {
        errors.country = "error.applicationCountry";
    }

    const email = asText(values.email).toLowerCase();
    if (!email) {
        errors.email = "error.applicationRequired";
    } else if (email.length > EMAIL_MAX || !EMAIL_RE.test(email)) {
        errors.email = "error.applicationEmail";
    }

    const company = text("company");
    if (!company) errors.company = "error.applicationRequired";

    const websiteRaw = text("website");
    const website = websiteRaw || null;
    if (website && !URL_RE.test(website)) {
        errors.website = "error.applicationUrl";
    }

    const businessTypes = pickOptions(asList(values.businessTypes), BUSINESS_TYPES);
    if (businessTypes.length === 0) errors.businessTypes = "error.applicationRequired";

    const brandExperience = asText(values.brandExperience);
    if (!(BRAND_EXPERIENCE as readonly string[]).includes(brandExperience)) {
        errors.brandExperience = "error.applicationRequired";
    }

    const channels = pickOptions(asList(values.channels), CHANNELS);
    if (channels.length === 0) errors.channels = "error.applicationRequired";

    // 选填：非法值直接丢弃（下拉已限定取值，这里只是不信任前端）
    const volumeRaw = asText(values.monthlyVolume);
    const monthlyVolume = (MONTHLY_VOLUMES as readonly string[]).includes(volumeRaw)
        ? volumeRaw
        : null;

    const messageRaw = asText(values.message);
    const message = messageRaw || null;
    if (message && message.length > MESSAGE_MAX) {
        errors.message = "error.applicationTooLong";
    }

    if (values.privacyConsent !== true) {
        errors.privacyConsent = "error.applicationConsent";
    }

    if (Object.keys(errors).length > 0) return { payload: null, errors };

    return {
        payload: {
            firstName,
            lastName,
            phone,
            country,
            email,
            company,
            website,
            businessTypes,
            brandExperience,
            channels,
            monthlyVolume,
            message,
            privacyConsent: true,
            locale,
        },
        errors,
    };
}

/**
 * 从已落库的 `payload`（Json）还原展示用字段：脏数据 / 老数据一律兜底为字符串 / 数组，
 * 后台列表不因一条坏数据整页崩。
 */
export function coercePayload(raw: unknown): ApplicationPayload {
    const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const pick = (key: string): string[] =>
        Array.isArray(source[key]) ? asList(source[key]) : [];
    const volume = asText(source.monthlyVolume);
    return {
        firstName: asText(source.firstName),
        lastName: asText(source.lastName),
        phone: asText(source.phone),
        country: asText(source.country),
        email: asText(source.email),
        company: asText(source.company),
        website: asText(source.website) || null,
        businessTypes: pick("businessTypes"),
        brandExperience: asText(source.brandExperience),
        channels: pick("channels"),
        monthlyVolume: volume || null,
        message: asText(source.message) || null,
        privacyConsent: source.privacyConsent === true,
        locale: asText(source.locale) || "en",
    };
}