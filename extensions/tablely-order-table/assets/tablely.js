/**
 * Tablely — 店面运行时（M4：最小骨架 + 关键的提交前归一化）
 *
 * 本文件是**渐进增强**：没有它，`snippets/table-markup.liquid` 的原生表单依然能
 * 多行加购（§五「无 JS 兜底」）。它现在只做两件在 M4 就必须做的事：
 *
 *   1. **提交前把空 / 非正数数量归一为 0**（M0 实测硬约束）：
 *      Shopify 对 `quantity` 缺失 / 空串 / 负数会**强制当作 1 件**加购，
 *      顾客清空某个数量格再提交就会莫名多买一件。归一为 `0` 则是静默 no-op。
 *      （`min="0"` 只能挡负数，挡不住空串。）
 *   2. 给表单打 `data-tablely-ready="true"`，供 M5 的增强逻辑与样式判定「已就绪」。
 *
 * ⚠️ 不做 AJAX、不做合计、不做反馈 UI —— 那些是 M5。体积硬约束 P2 ≤ 15 KB gzip，
 *    由 CI（scripts/check-bundle.ts）断言。
 */

(function () {
  'use strict';

  var READY_ATTR = 'data-tablely-ready';
  var FORM_SELECTOR = '[data-tablely-form]';
  var QTY_SELECTOR = 'input[type="number"][name$="[quantity]"]';

  /** 把一张表里所有数量格的非正数 / 空值写成 "0"（Shopify 会忽略 0 数量行） */
  function normalizeQuantities(form) {
    var inputs = form.querySelectorAll(QTY_SELECTOR);
    for (var i = 0; i < inputs.length; i++) {
      var input = inputs[i];
      var value = parseInt(input.value, 10);
      input.value = isFinite(value) && value > 0 ? String(value) : '0';
    }
  }

  function onSubmit(event) {
    var form = event.currentTarget;
    if (form && form.querySelector) normalizeQuantities(form);
  }

  function enhance(form) {
    if (!form || form.getAttribute(READY_ATTR) === 'true') return;
    form.addEventListener('submit', onSubmit);
    form.setAttribute(READY_ATTR, 'true');
  }

  function init() {
    var forms = document.querySelectorAll(FORM_SELECTOR);
    for (var i = 0; i < forms.length; i++) enhance(forms[i]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // 主题编辑器会动态插入 / 重排区块，插入后重新增强
  document.addEventListener('shopify:section:load', function (event) {
    var scope = event && event.target ? event.target : document;
    var forms = scope.querySelectorAll ? scope.querySelectorAll(FORM_SELECTOR) : [];
    for (var i = 0; i < forms.length; i++) enhance(forms[i]);
  });
})();