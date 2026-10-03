/**
 * 七语 key 一致性校验（npm run check-i18n）
 *
 * 校验三件事：
 *   1. 每个语种的 key 集合与英文基准完全相同（不缺、不多）
 *   2. 每个 key 的占位符（如 {days}）在七语中保持一致
 *   3. 没有空字符串翻译
 *
 * 有任何不一致即以非 0 退出，用于 CI / 本地提交前检查。
 */
import { DICTIONARIES, LOCALES } from "../app/i18n";

type Dict = Record<string, string>;

const base = DICTIONARIES.en as Dict;
const baseKeys = Object.keys(base).sort();

function placeholders(text: string): string[] {
  const found = text.match(/\{(\w+)\}/g) ?? [];
  return [...new Set(found)].sort();
}

let errors = 0;

function report(message: string) {
  errors += 1;
  console.error(`  ✗ ${message}`);
}

for (const locale of LOCALES) {
  const dict = DICTIONARIES[locale] as Dict | undefined;
  if (!dict) {
    report(`${locale}: 字典缺失`);
    continue;
  }

  const keys = Object.keys(dict).sort();
  const missing = baseKeys.filter((key) => !(key in dict));
  const extra = keys.filter((key) => !(key in base));

  if (missing.length || extra.length) {
    console.error(`\n[${locale}]`);
    for (const key of missing) report(`缺少 key: ${key}`);
    for (const key of extra) report(`多余 key: ${key}`);
    continue;
  }

  const problems: string[] = [];
  for (const key of baseKeys) {
    const value = dict[key];
    if (typeof value !== "string" || !value.trim()) {
      problems.push(`空翻译: ${key}`);
      continue;
    }
    const expected = placeholders(base[key]);
    const actual = placeholders(value);
    if (expected.join(",") !== actual.join(",")) {
      problems.push(
        `占位符不一致: ${key}（基准 [${expected.join(", ")}] vs 实际 [${actual.join(", ")}]）`,
      );
    }
  }

  if (problems.length) {
    console.error(`\n[${locale}]`);
    for (const problem of problems) report(problem);
  }
}

if (errors > 0) {
  console.error(`\ncheck-i18n 失败：共 ${errors} 个问题（基准语言 en，共 ${baseKeys.length} 个 key）`);
  process.exit(1);
}

console.log(
  `check-i18n 通过：${LOCALES.length} 个语种 × ${baseKeys.length} 个 key，全部一致`,
);
