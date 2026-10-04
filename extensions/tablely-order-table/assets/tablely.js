/**
 * Tablely — 店面运行时（M4 骨架 → M5 完整增强）
 *
 * 本文件是**渐进增强**：没有它，`snippets/table-markup.liquid` 的原生表单依然能
 * 多行加购（§五「无 JS 兜底」）。M5 在它之上补齐：
 *
 *   1. **步进器**（− / +）：按 `min / max / step / 库存` 约束改数量，键盘可达（B14）；
 *   2. **实时合计**：行数 · 件数 · 预估金额，金额与表格 `| money` 同源同口径；
 *   3. **AJAX 加购**：行内单行加购 + 整表加购，`POST routes.cart_add_url`（JSON，多 items）；
 *   4. **行内反馈（§五 5 条规则）**：成功 `✓ 已加入` 2s 复原 + 顶部轻提示；部分成功给汇总；
 *      全部失败逐行给原因；缺货行置灰 + 文案；低于起订量 / 非步长倍数**提交前拦截**；
 *   5. **可访问性（B14）**：原生可聚焦控件、`role="status"` / `role="alert"` 分离、
 *      不靠颜色表达状态、焦点可见由 CSS 的 `:focus-visible` 提供；
 *   6. **Y14 整单起订金额闸门**：未达阈值 → 提交按钮 `disabled` + `role="status"` 进度，
 *      **不发任何 `/cart/add` 请求**；判断按**折前小计**、在折扣之前（§16.6）。
 *
 * ⚠️ **提交前把空 / 非正数数量归一为 0**（M0 实测硬约束）：Shopify 对 `quantity`
 *    缺失 / 空串 / 负数会**强制当作 1 件**加购，顾客清空某个数量格再提交就会莫名多买一件。
 *
 * ⚠️ **起订金额只管整表提交**，不拦行内单行加购 —— 行内按钮的语义是「先加这一件」，
 *    若也按整表小计闸门，表格没填满时该按钮全程不可用（§16.6 的门控对象是「本次整表提交」）。
 *
 * ⚠️ 体积硬约束 P2 ≤ 15 KB gzip，由 CI（scripts/check-bundle.ts）断言。
 *    文案一律由 `#tablely-config` 注入（Liquid 侧取 7 语），本文件不含任何自然语言。
 */

(function () {
  'use strict';

  var READY_ATTR = 'data-tablely-ready';
  var BUSY_ATTR = 'data-tablely-busy';
  var FORM_SELECTOR = '[data-tablely-form]';
  var ROW_SELECTOR = '[data-tablely-row]';
  var QTY_SELECTOR = '.tablely-qty';
  /** 行内「✓ 已加入」停留时长（§五 反馈规则第 1 条：2s 复原） */
  var RESTORE_MS = 2000;
  /** 加购成功后做计数联动的主题选择器（主题各异，命中即更新；见 refreshCart 注释） */
  var COUNT_SELECTORS = [
    '[data-cart-count]',
    '#cart-icon-bubble span',
    '.cart-count-bubble span',
    '.cart-count-bubble__count',
    '[data-cart-count-bubble] span',
  ];

  var config = readConfig();
  var strings = (config && config.strings) || {};
  var moneyFormat = (config && config.moneyFormat) || '${{amount}}';
  var addUrl = (config && config.cartAddUrl) || '/cart/add';
  var cartUrl = (config && config.cartUrl) || '/cart';
  /* M8 反馈呈现方式：inline（默认）/ toast / both */
  var feedbackStyle =
    (config && config.settings && config.settings.feedbackStyle) || 'inline';

  /* ============================== 基础工具 ============================== */

  /** 读 `#tablely-config`（缺失 / 非法一律 null，绝不抛错中断增强） */
  function readConfig() {
    var el = document.getElementById('tablely-config');
    if (!el) return null;
    try {
      return JSON.parse(el.textContent || 'null');
    } catch (error) {
      return null;
    }
  }

  /**
   * 文案插值：替换 locale 里的 `{{ name }}` 占位符（与主题 `| t` 的占位符格式一致）。
   *
   * ⚠️ 占位符必须是**双花括号**且**在 JS 侧替换** —— Liquid 的输出语句里出现字面 `{` `}`
   * 会让解析器提前截断（M5 实测由 theme check 捕获），所以 `table-runtime.liquid`
   * 只做 `| t | json`，不做参数替换。
   *
   * 做成工厂是为了可单测：真实调用处 `t` 绑定了「主题注入的 7 语字典」，
   * 而单测需要一个可传入自定义字典的入口（见文件末的单测钩子）。
   */
  function makeT(dict) {
    var messages = dict || {};
    return function (key, vars) {
      var template = messages[key];
      if (typeof template !== 'string') return '';
      if (!vars) return template;
      return template.replace(/\{\{\s*(\w+)\s*\}\}|\{(\w+)\}/g, function (match, braced, bare) {
        var name = braced || bare;
        return Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match;
      });
    };
  }

  var t = makeT(strings);

  function withDelimiters(cents, precision, thousands, decimal) {
    var value = typeof cents === 'number' && isFinite(cents) ? cents : 0;
    var parts = (value / 100).toFixed(precision).split('.');
    var whole = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, thousands);
    return parts[1] ? whole + decimal + parts[1] : whole;
  }

  /**
   * 按店铺 `money_format` 格式化**整数分**金额。
   *
   * 为什么必须与主题同源：合计和起订金额进度若用另一套格式，会出现
   * 「表格显示 820，进度却显示 819.99」这类「显示达标却被拦」的观感事故
   * （§十三 风险表 Y14 行）。占位符实现 Shopify 官方的四种 amount 变体。
   */
  function formatMoney(cents, format) {
    var formatString = format || '${{amount}}';
    var placeholder = /\{\{\s*(\w+)\s*\}\}/;
    var match = formatString.match(placeholder);
    var token = match ? match[1] : 'amount';
    var value;
    if (token === 'amount_no_decimals') {
      value = withDelimiters(cents, 0, ',', '.');
    } else if (token === 'amount_with_comma_separator') {
      value = withDelimiters(cents, 2, '.', ',');
    } else if (token === 'amount_no_decimals_with_comma_separator') {
      value = withDelimiters(cents, 0, '.', ',');
    } else {
      value = withDelimiters(cents, 2, ',', '.');
    }
    return formatString.replace(placeholder, value);
  }

  /** 十进制字符串（`"1000.00"`）→ 整数分；空 / 非数字 → null（= 不限） */
  function toCents(value) {
    if (value === null || value === undefined) return null;
    var text = String(value).trim();
    if (text === '') return null;
    var number = parseFloat(text);
    return isFinite(number) ? Math.round(number * 100) : null;
  }

  function numAttr(el, name, fallback) {
    var value = parseFloat(el.getAttribute(name));
    return isFinite(value) ? value : fallback;
  }

  function optNumAttr(el, name) {
    var raw = el.getAttribute(name);
    if (raw === null || raw === '') return null;
    var value = parseFloat(raw);
    return isFinite(value) ? value : null;
  }

  /* ============================== 行工具 ============================== */

  function qtyInput(row) {
    return row ? row.querySelector(QTY_SELECTOR) : null;
  }

  /** 当前订单数量（空 / 非正数一律算 0，「0 件」= 不参与本次加购） */
  function qtyOf(row) {
    var input = qtyInput(row);
    if (!input) return 0;
    var value = parseInt(input.value, 10);
    return isFinite(value) && value > 0 ? value : 0;
  }

  /** 行级校验（§五 反馈规则第 5 条）：返回 null（通过）或 `{ key, vars }` */
  function rowError(row) {
    if (row.getAttribute('data-soldout') === 'true') return { key: 'soldOut' };
    var qty = qtyOf(row);
    if (qty <= 0) return null;

    var min = numAttr(row, 'data-min', 1);
    if (qty < min) return { key: 'belowMin', vars: { n: min } };

    var step = numAttr(row, 'data-step', 1);
    if (step > 1 && qty % step !== 0) return { key: 'wrongStep', vars: { n: step } };

    // 库存先于上限：两者都命中时，「库存仅剩 N 件」对顾客更可行动
    var stock = optNumAttr(row, 'data-stock');
    if (stock !== null && qty > stock) return { key: 'lowStock', vars: { n: stock } };

    var max = optNumAttr(row, 'data-max');
    if (max !== null && qty > max) return { key: 'aboveMax', vars: { n: max } };

    return null;
  }

  function rowMessageEl(row) {
    return row ? row.querySelector('[data-tablely-row-msg]') : null;
  }

  function setRowMessage(row, error) {
    var el = rowMessageEl(row);
    if (!el) return;
    if (error) {
      el.textContent = t(error.key, error.vars);
      row.setAttribute('data-tablely-invalid', 'true');
    } else {
      el.textContent = '';
      row.removeAttribute('data-tablely-invalid');
    }
  }

  /* ============================== 合计与闸门 ============================== */

  function computeTotals(form) {
    var rows = form.querySelectorAll(ROW_SELECTOR);
    var totals = { rows: 0, units: 0, cents: 0 };
    for (var i = 0; i < rows.length; i++) {
      var qty = qtyOf(rows[i]);
      if (qty <= 0) continue;
      totals.rows += 1;
      totals.units += qty;
      totals.cents += numAttr(rows[i], 'data-price', 0) * qty;
    }
    return totals;
  }

  /** 生效阈值（分）；`null` = 不限 */
  function orderMinCents(form) {
    var cents = toCents(form.getAttribute('data-tablely-order-min'));
    return cents !== null && cents > 0 ? cents : null;
  }

  function isBusy(form) {
    return form.getAttribute(BUSY_ATTR) === 'true';
  }

  function setBusy(form, busy) {
    if (busy) form.setAttribute(BUSY_ATTR, 'true');
    else form.removeAttribute(BUSY_ATTR);
    updateSummary(form);
  }

  /** 合计 + 起订金额进度 + 提交按钮闸门（数量变动、加购完成后都要重算） */
  function updateSummary(form) {
    var totals = computeTotals(form);
    var min = orderMinCents(form);

    var summaryEl = form.querySelector('[data-tablely-summary]');
    if (summaryEl) {
      summaryEl.textContent = t('summary', {
        rows: totals.rows,
        units: totals.units,
        total: formatMoney(totals.cents, moneyFormat),
      });
    }

    var met = min === null || totals.cents >= min;

    if (min !== null) {
      var labelEl = form.querySelector('[data-tablely-ordermin-label]');
      var progressEl = form.querySelector('[data-tablely-ordermin-progress]');
      var msgEl = form.querySelector('[data-tablely-ordermin-msg]');
      if (labelEl) {
        labelEl.textContent = t('orderMinLabel', {
          amount: formatMoney(min, moneyFormat),
        });
      }
      if (progressEl) {
        progressEl.textContent = t('orderMinProgress', {
          current: formatMoney(totals.cents, moneyFormat),
          min: formatMoney(min, moneyFormat),
        });
      }
      if (msgEl) {
        // 文案相同就不写回：避免每次改数量都触发一次 live region 播报（B14 降噪）
        var text = met
          ? ''
          : t('orderMinNotMet', {
                amount: formatMoney(min - totals.cents, moneyFormat),
            });
        if (msgEl.textContent !== text) msgEl.textContent = text;
      }
    }

    var submit = form.querySelector('[data-tablely-submit]');
    if (submit) submit.disabled = isBusy(form) || !met;
  }

  /* ============================== 反馈（§五 5 条规则） ============================== */

  function clearFeedback(form) {
    var okEl = form.querySelector('[data-tablely-feedback-ok]');
    var errEl = form.querySelector('[data-tablely-feedback-err]');
    if (okEl) {
      okEl.hidden = true;
      okEl.textContent = '';
    }
    if (errEl) {
      errEl.hidden = true;
      errEl.textContent = '';
    }
  }

  /** kind：`ok` → `role="status"`；`error` → `role="alert"`（两个容器分开，见 Liquid 注释） */
  function showFeedback(form, kind, text) {
    clearFeedback(form);
    if (!text) return;
    var el = form.querySelector(
      kind === 'error' ? '[data-tablely-feedback-err]' : '[data-tablely-feedback-ok]',
    );
    if (el) {
      el.textContent = text;
      el.hidden = false;
    }
    showToast(form, kind, text);
  }

  /* M8：浮层副本（`feedbackStyle = toast / both` 时才出现）。
     行内容器始终更新（读屏真源），浮层只是 `aria-hidden` 的视觉镜像，3s 后自动消失。 */
  var toastTimer = null;

  function showToast(form, kind, text) {
    if (feedbackStyle === 'inline') return;
    var root = form.closest('.tablely-root') || document;
    var toast = root.querySelector('[data-tablely-toast]');
    if (!toast) return;
    toast.textContent = text;
    toast.className =
      kind === 'error' ? 'tablely-toast tablely-toast--error' : 'tablely-toast';
    toast.hidden = false;
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      toast.hidden = true;
    }, 3000);
  }

  function markFailures(failures) {
    for (var i = 0; i < failures.length; i++) {
      setRowMessage(failures[i].row, failures[i].error);
    }
  }

  /** 行内按钮 → `✓ 已加入`，RESTORE_MS 后复原（§五 反馈规则第 1 条） */
  function flashAdded(row) {
    var button = row ? row.querySelector('[data-tablely-add]') : null;
    if (!button || button.getAttribute('data-tablely-flash') === 'true') return;
    var original = button.textContent;
    button.setAttribute('data-tablely-flash', 'true');
    button.textContent = '✓ ' + t('added');
    window.setTimeout(function () {
      button.textContent = original;
      button.removeAttribute('data-tablely-flash');
    }, RESTORE_MS);
  }

  /* ============================== AJAX ============================== */

  function postCart(body) {
    return fetch(addUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    }).then(function (response) {
      return response
        .json()
        .catch(function () {
          return null;
        })
        .then(function (data) {
          return { ok: response.ok, data: data };
        });
    });
  }

  /**
   * 计数联动（#9 的**退化实现**）：拉一次 `/cart.js` 更新常见计数节点，
   * 并广播 `cart:updated` 供主题自行刷新抽屉 / 气泡。
   *
   * 主题的购物车 DOM 千差万别，这里只做「命中即更新」，**失败一律静默**——
   * 计数联动是增强，绝不能因为它抛错而影响加购结果本身。
   */
  function refreshCart() {
    fetch(cartUrl + '.js', { headers: { Accept: 'application/json' } })
      .then(function (response) {
        return response.ok ? response.json() : null;
      })
      .then(function (cart) {
        if (!cart) return;
        try {
          document.dispatchEvent(new CustomEvent('cart:updated', { detail: cart }));
        } catch (error) {
          /* 老浏览器不支持 CustomEvent 构造器：忽略 */
        }
        if (typeof cart.item_count !== 'number') return;
        for (var i = 0; i < COUNT_SELECTORS.length; i++) {
          var nodes = document.querySelectorAll(COUNT_SELECTORS[i]);
          for (var j = 0; j < nodes.length; j++) {
            nodes[j].textContent = String(cart.item_count);
          }
        }
      })
      .catch(function () {});
  }

  /* ============================== 收集与提交 ============================== */

  /**
   * 汇总本次要提交的行。
   *
   * 校验不通过的行**不进请求**（规则 5：提交前拦截），但会被记进 `failures`
   * 用于「部分成功」的反馈 —— 这正是 §五 规则 2「3 行已加入，1 行失败」的来源。
   */
  function collect(form) {
    var rows = form.querySelectorAll(ROW_SELECTOR);
    var items = [];
    var okRows = [];
    var failures = [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (row.getAttribute('data-soldout') === 'true') continue;
      var qty = qtyOf(row);
      if (qty <= 0) continue;
      var error = rowError(row);
      if (error) {
        failures.push({ row: row, error: error });
        continue;
      }
      var vid = parseInt(row.getAttribute('data-vid'), 10);
      if (!isFinite(vid)) continue;
      okRows.push(row);
      items.push({ id: vid, quantity: qty });
    }
    return { items: items, rows: okRows, failures: failures };
  }

  /** 提交前把空 / 非正数数量写成 "0"（M0 实测：空串 / 负数会被 Shopify 当 1 件） */
  function normalizeQuantities(form) {
    var inputs = form.querySelectorAll('input[type="number"][name$="[quantity]"]');
    for (var i = 0; i < inputs.length; i++) {
      var value = parseInt(inputs[i].value, 10);
      inputs[i].value = isFinite(value) && value > 0 ? String(value) : '0';
    }
  }

  function onInput(event) {
    var form = event.currentTarget;
    var target = event.target;
    if (!target || !target.classList || !target.classList.contains('tablely-qty')) return;
    var row = target.closest ? target.closest(ROW_SELECTOR) : null;
    if (row) setRowMessage(row, null);
    updateSummary(form);
  }

  /**
   * 步进器取下一个值（纯函数，便于单测）：
   *   · 从 0 往上先落到 `min`（默认最小起订量），之后按 `step` 递增；
   *   · 往下低于 `min` 直接回 `0`（= 这一行不订购）；
   *   · 触顶（`max`，已并入库存上限）就**保持原值**不增长；越界手输仍由 `rowError` 拦下。
   */
  function nextQuantity(current, direction, bounds) {
    var step = bounds.step > 0 ? bounds.step : 1;
    var min = bounds.min >= 0 ? bounds.min : 1;
    var next =
      direction > 0
        ? current < min
          ? min
          : current + step
        : current - step < min
          ? 0
          : current - step;
    if (bounds.max !== null && next > bounds.max) return current;
    return next < 0 ? 0 : next;
  }

  /** 步进器：约束来自行上的 data-min / data-max / data-step / data-stock（B14 键盘可达） */
  function stepRow(row, direction) {
    if (!row) return;
    var input = qtyInput(row);
    if (!input || input.disabled) return;

    var max = optNumAttr(row, 'data-max');
    var stock = optNumAttr(row, 'data-stock');
    if (stock !== null) max = max === null ? stock : Math.min(max, stock);

    var current = parseInt(input.value, 10);
    if (!isFinite(current) || current < 0) current = 0;

    var next = nextQuantity(current, direction, {
      min: numAttr(row, 'data-min', 1),
      max: max,
      step: numAttr(row, 'data-step', 1),
    });
    if (next === current) return;

    input.value = String(next);
    setRowMessage(row, null);
  }

  /** 行内单行加购（**不受整表起订金额闸门约束**，见文件头说明） */
  function addRow(form, row) {
    if (!row || isBusy(form)) return;
    var error = rowError(row);
    setRowMessage(row, error);
    if (error) return;
    var qty = qtyOf(row);
    if (qty <= 0) return;
    var vid = parseInt(row.getAttribute('data-vid'), 10);
    if (!isFinite(vid)) return;

    setBusy(form, true);
    postCart({ items: [{ id: vid, quantity: qty }] })
      .then(function (result) {
        setBusy(form, false);
        if (result.ok) {
          flashAdded(row);
          showFeedback(form, 'ok', t('added'));
          refreshCart();
        } else {
          setRowMessage(row, { key: 'error' });
          showFeedback(form, 'error', t('error'));
        }
      })
      .catch(function () {
        setBusy(form, false);
        setRowMessage(row, { key: 'error' });
        showFeedback(form, 'error', t('error'));
      });
  }

  function onSubmit(event) {
    var form = event.currentTarget;
    // 未增强（理论上不会）→ 交给原生表单，保住无 JS 兜底路径
    if (form.getAttribute(READY_ATTR) !== 'true') return;
    event.preventDefault();
    if (isBusy(form)) return;

    normalizeQuantities(form);
    clearFeedback(form);

    var plan = collect(form);
    if (!plan.items.length) {
      // 规则 3：全部失败 → 逐行红字原因；无可提交行则**不发任何请求**
      markFailures(plan.failures);
      updateSummary(form);
      return;
    }

    var min = orderMinCents(form);
    if (min !== null && computeTotals(form).cents < min) {
      // 规则 5 / 验收 32：未达起订金额不发 /cart/add（按钮 disabled 之外的第二道闸）
      updateSummary(form);
      return;
    }

    setBusy(form, true);
    postCart({ items: plan.items })
      .then(function (result) {
        setBusy(form, false);
        if (!result.ok) {
          markFailures(
            plan.rows.map(function (row) {
              return { row: row, error: { key: 'error' } };
            }),
          );
          showFeedback(form, 'error', t('error'));
          return;
        }
        for (var i = 0; i < plan.rows.length; i++) flashAdded(plan.rows[i]);
        markFailures(plan.failures);
        var failCount = plan.failures.length;
        // 规则 2：部分成功给汇总（整体算成功，逐行失败原因已由 role="alert" 播报）
        showFeedback(
          form,
          'ok',
          failCount
            ? t('partial', { ok: plan.rows.length, fail: failCount })
            : t('added'),
        );
        refreshCart();
        updateSummary(form);
      })
      .catch(function () {
        setBusy(form, false);
        markFailures(
          plan.rows.map(function (row) {
            return { row: row, error: { key: 'error' } };
          }),
        );
        showFeedback(form, 'error', t('error'));
      });
  }

  function onClick(event) {
    var form = event.currentTarget;
    var target = event.target;
    if (!target || !target.closest) return;

    var stepButton = target.closest('[data-tablely-step]');
    if (stepButton && !stepButton.disabled) {
      event.preventDefault();
      stepRow(stepButton.closest(ROW_SELECTOR), numAttr(stepButton, 'data-tablely-step', 0));
      updateSummary(form);
      return;
    }

    var addButton = target.closest('[data-tablely-add]');
    if (addButton && !addButton.disabled) {
      event.preventDefault();
      addRow(form, addButton.closest(ROW_SELECTOR));
    }
  }

  /* ============================== 单测钩子 ============================== */

  /**
   * 本文件是主题资产（无模块系统），纯函数无法被 vitest 直接 import。
   * 宿主显式提供 `window.__TABLELY_TEST__` 时把纯函数挂出去供单测调用；
   * 浏览器里该全局恒不存在，等于零行为、零副作用（见 app/services/storefront-runtime.test.ts）。
   */
  if (typeof window !== 'undefined' && window.__TABLELY_TEST__) {
    window.__TABLELY_TEST__.makeT = makeT;
    window.__TABLELY_TEST__.formatMoney = formatMoney;
    window.__TABLELY_TEST__.toCents = toCents;
    window.__TABLELY_TEST__.rowError = rowError;
    window.__TABLELY_TEST__.nextQuantity = nextQuantity;
    window.__TABLELY_TEST__.computeTotals = computeTotals;
  }

  /* ============================== 装配 ============================== */

  function enhance(form) {
    if (!form || form.getAttribute(READY_ATTR) === 'true') return;
    form.addEventListener('submit', onSubmit);
    form.addEventListener('click', onClick);
    form.addEventListener('input', onInput);
    form.setAttribute(READY_ATTR, 'true');
    updateSummary(form);
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