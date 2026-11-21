(() => {
  "use strict";

  if (window.top !== window || window.__VPEWorkflowLoaded) return;
  window.__VPEWorkflowLoaded = true;

  const ALL_TRAFFIC = ["推荐列表", "首页banner", "搜索推广", "信息流", "原生", "激励视频", "插屏", "开屏", "BANNER"];
  const GROUPS = ["商店", "非商店", "联盟"];
  const clean = text => String(text || "").replace(/\s+/g, "").replace(/\u00a0/g, "")
    .replace(/[＊*]/g, "").replace(/[?？]$/g, "").trim();
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const within = (value, target) => clean(value) === clean(target);

  let active = false;
  let currentRun = null;
  let statusHost;
  let statusRoot;
  const stoppedRunIds = new Set();
  let lastErrorText = "";

  function assertNotStopped() {
    if (currentRun?.id && stoppedRunIds.has(currentRun.id))
      throw new Error("用户已主动停止当前任务。");
  }

  function visible(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }

  function leavesWithText(text, { contains = false } = {}) {
    // Restrict to short text-bearing elements, never large page containers.
    const nodes = document.querySelectorAll("label,span,button,a,li,div,p,strong,h2,h3");
    return [...nodes].filter(el => {
      if (!visible(el)) return false;
      const own = clean(el.textContent);
      if (own.length > 180) return false;
      if (!(contains ? own.includes(clean(text)) : within(own, text))) return false;
      return ![...el.children].some(child => within(child.textContent, text));
    }).sort((a, b) => {
      const ac = a.querySelectorAll("*").length;
      const bc = b.querySelectorAll("*").length;
      return ac - bc;
    });
  }

  function textNode(text, opts) {
    return leavesWithText(text, opts)[0] || null;
  }

  async function until(check, timeout = 9000, description = "目标元素") {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      assertNotStopped();
      const result = await check();
      assertNotStopped();
      if (result) return result;
      await delay(170);
    }
    throw new Error(`未找到${description}，请截取当前页面并提供该控件的 HTML。`);
  }

  function click(el) {
    assertNotStopped();
    if (!el || !visible(el)) throw new Error("尝试点击的控件不可见。");
    el.scrollIntoView({ block: "center", inline: "nearest" });
    assertNotStopped();
    el.click();
  }

  function clickText(text, opts = {}) {
    const el = textNode(text, opts);
    if (!el) throw new Error(`未找到选项「${text}」。`);
    click(el.closest("button,[role='option'],[role='menuitem'],label,li") || el);
    return el;
  }

  function nearestControl(label, filter) {
    const candidates = leavesWithText(label);
    const controls = [...document.querySelectorAll(filter)].filter(visible);
    for (const el of candidates) {
      const item = el.closest(".ant-form-item,.el-form-item,[class*='formItem'],[class*='form-item']");
      const nested = item && [...item.querySelectorAll(filter)].find(visible);
      if (nested) return nested;
      const labelBox = el.getBoundingClientRect();
      const near = controls.map(control => {
        const r = control.getBoundingClientRect();
        const dy = Math.abs((r.top + r.bottom) / 2 - (labelBox.top + labelBox.bottom) / 2);
        const dx = r.left - labelBox.right;
        return { control, dy, dx };
      }).filter(x => x.dx >= -15 && x.dx < 760 && x.dy < 70)
        .sort((a, b) => a.dy * 4 + a.dx / 50 - (b.dy * 4 + b.dx / 50));
      if (near[0]) return near[0].control;
    }
    return null;
  }

  function formItem(label) {
    // vivo 新版的 form-item 标签常由 Element Plus 的多层 span/div 包裹。
    return leavesWithText(label).map(node =>
      node.closest(".el-form-item,.ant-form-item,[class*='formItem'],[class*='form-item']"))
      .find(item => item && visible(item)) || null;
  }

  function selectionControl(label) {
    const item = formItem(label);
    if (label === "优化目标") {
      const goal = document.querySelector("#cvType .el-select__wrapper,#cvType .el-select");
      if (goal && visible(goal)) return goal;
    }
    if (item) {
      // 真实 DOM：.el-select__wrapper；应用/行业还使用 cascader 和自定义 mkt 组件。
      const selectors = [
        ".el-select__wrapper", ".el-cascader .el-input__wrapper",
        ".mkt-cascader .el-input__wrapper", ".el-input__wrapper",
        ".el-select", ".el-cascader", "[role='combobox']",
        "input:not([type='checkbox']):not([type='radio'])"
      ];
      for (const selector of selectors) {
        const element = [...item.querySelectorAll(selector)].find(visible);
        if (element) return element;
      }
    }
    return nearestControl(label,
      ".el-select__wrapper,.el-input__wrapper,[role='combobox'],input:not([type=checkbox]):not([type=radio])");
  }

  function menuOption(value, { prefix = false } = {}) {
    // 截图确认：应用和行业/产品是 li.el-cascader-node / div.options-item。
    // 只检索弹出的菜单选项，避免误点表单中已经显示的同名文字。
    const candidates = [...document.querySelectorAll(
      "li.el-cascader-node,[role='menuitem'],[role='option'],.el-select-dropdown__item,.el-cascader-node")]
      .filter(visible);
    const match = node => {
      const content = clean(node.querySelector(".options-item")?.textContent || node.textContent);
      return prefix ? content.startsWith(clean(value)) : content === clean(value);
    };
    return candidates.find(match) || (prefix ? candidates.find(node =>
      clean(node.textContent).includes(clean(value))) : null) || null;
  }

  function nativeSet(input, value) {
    if (!input) throw new Error("未找到输入框。");
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    input.focus();
    setter.call(input, String(value));
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: String(value) }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.blur();
  }

  async function fillByLabel(label, value, placeholder = "") {
    const input = (placeholder && [...document.querySelectorAll("input,textarea")].find(el =>
      visible(el) && clean(el.placeholder).includes(clean(placeholder)))) ||
      nearestControl(label, "input:not([type=checkbox]):not([type=radio]),textarea");
    if (!input) throw new Error(`未找到「${label}」对应的输入框。`);
    nativeSet(input, value);
    await delay(180);
    if (String(input.value).trim() !== String(value).trim()) {
      throw new Error(`「${label}」输入后未保持预期值，需要确认该输入框的真实 DOM。`);
    }
  }

  async function fillBid(value) {
    const anchor = textNode("元/转化");
    if (!anchor) throw new Error("未找到优化目标右侧的「元/转化」出价输入区域。");
    const a = anchor.getBoundingClientRect();
    const candidates = [...document.querySelectorAll("input:not([type=checkbox]):not([type=radio])")]
      .filter(visible)
      .map(input => ({ input, rect: input.getBoundingClientRect() }))
      .filter(x => Math.abs(x.rect.top - a.top) < 60 && x.rect.right <= a.left + 20 && a.left - x.rect.right < 290)
      .sort((x, y) => y.rect.right - x.rect.right);
    const input = candidates[0]?.input;
    if (!input) throw new Error("未找到优化目标旁边的出价金额输入框。");
    nativeSet(input, value);
    await delay(180);
    if (input.value !== String(value)) throw new Error("出价金额输入未保持，已停止。");
  }

  function checkbox(label) {
    // 用户提供的真实 HTML：
    // .media-place-select > .media-div > label.el-checkbox.place-type-item
    //   > span.el-checkbox__input > input.el-checkbox__original[value="推荐列表"]
    //   > span.el-checkbox__label。input 本身是隐藏的，必须点击外层 label。
    const trafficArea = document.querySelector("#contentAndTargetId .media-place-select") ||
      document.querySelector(".media-place-select");
    const roots = trafficArea ? [trafficArea] : [document];
    for (const root of roots) {
      for (const input of root.querySelectorAll("label.el-checkbox input[type='checkbox']")) {
        const trigger = input.closest("label.el-checkbox");
        if (trigger && visible(trigger) &&
            (within(input.value, label) ||
             within(trigger.querySelector(".el-checkbox__label")?.textContent, label))) {
          return { input, trigger };
        }
      }
    }
    return null;
  }

  function checkboxChecked(found) {
    return !!(found && (found.input.checked || found.trigger.classList.contains("is-checked")));
  }

  async function setCheckbox(label, checked) {
    const found = checkbox(label);
    if (!found) throw new Error(`无法识别流量位置「${label}」的复选框结构。`);
    if (checkboxChecked(found) !== checked) {
      click(found.trigger);
      await until(() => checkboxChecked(found) === checked, 1600, `流量位置「${label}」状态更新`);
    }
    if (checkboxChecked(found) !== checked) throw new Error(`未能${checked ? "勾选" : "取消"}「${label}」。`);
  }

  async function configureTraffic(items) {
    say("正在设置流量位置（仅保留你在扩展中选择的项目）…");
    // Do not rely on parent groups' partial-checkbox semantics. Set each child explicitly.
    for (const label of ALL_TRAFFIC) await setCheckbox(label, false);
    for (const label of items) await setCheckbox(label, true);
    for (const label of ALL_TRAFFIC) {
      const found = checkbox(label);
      if (!found || checkboxChecked(found) !== items.includes(label)) {
        throw new Error(`流量位置「${label}」最终状态不符合配置，已停止。`);
      }
    }
  }

  function goalSelected(value) {
    // 实际页面 DOM：#cvType .el-select__selected-item.el-select__placeholder > span。
    // 该节点即使带 is-transparent，也会保留已选中的真实文案。
    const root = document.querySelector("#cvType");
    const selected = root?.querySelector(
      ".el-select__selected-item.el-select__placeholder span," +
      ".el-select__selected-item:not(.el-select__input-wrapper)"
    );
    return !!selected && within(selected.textContent, value);
  }

  function goalOptions() {
    // vivo 新建计划页面使用 newads-app__cvtype-select；老版为 ads-app__cvtype-select。
    // 弹层挂载在 body 下。带帮助提示的选项可能不是 li，不能限制标签名；
    // 例如“自定义拉活 (?)”不能因特殊结构漏掉。
    const popups = [...document.querySelectorAll(
      ".newads-app__cvtype-select,.ads-app__cvtype-select")]
      .filter(el => visible(el) && el.getAttribute("aria-hidden") !== "true");
    const candidates = [...new Set(popups.flatMap(popup => [...popup.querySelectorAll(
      ".el-select-dropdown__item,.ep-select-dropdown__item,[role='option']")]))];
    return candidates.filter(el => visible(el) &&
      !candidates.some(outer => outer !== el && outer.contains?.(el)));
  }

  function goalOptionName(option) {
    const goals = ["下载", "新增激活", "自定义付费", "自定义激活", "自定义拉活", "自定义注册"];
    // .cvtype-info 可能是“?”帮助图标，不能把它优先当作目标名称。
    const leaves = [...option.querySelectorAll(
      ".cvtype-text,.cvtype-name,.cvtype-label,span")]
      .filter(el => !el.querySelector("span,.cvtype-text,.cvtype-name,.cvtype-label"));
    const matches = [...new Set(leaves.map(el => clean(el.textContent)).filter(name => goals.includes(name)))];
    if (matches.length === 1) return matches[0];
    const raw = clean(option.textContent);
    if (goals.includes(raw)) return raw;
    const helped = goals.filter(name => raw.startsWith(name) &&
      /^[?？ⓘ]+$/.test(raw.slice(name.length)));
    return helped.length === 1 ? helped[0] : raw;
  }

  function selectableGoalOptions() {
    return goalOptions().filter(el => !el.matches(
      ".is-disabled,[aria-disabled='true'],[disabled]"
    ));
  }

  async function waitForGoalOption(value) {
    // vivo 会异步更新优化目标列表。出现 1～5 个其他选项不代表目标项
    // 已渲染完毕；必须等待“目标项本身”唯一且可点击，不能固定等 140ms 后报错。
    try {
      return await until(() => {
        const matches = selectableGoalOptions().filter(
          option => goalOptionName(option) === clean(value)
        );
        if (matches.length > 1)
          throw new Error(`优化目标「${value}」出现多个可点击项，已安全停止。`);
        return matches.length === 1 ? matches[0] : null;
      }, 6500, `优化目标「${value}」可点击选项`);
    } catch (error) {
      if (/多个可点击项|用户已主动停止/.test(error.message)) throw error;
      throw new Error(`优化目标「${value}」等待 6.5 秒仍未出现唯一可点击项；当前菜单：${goalOptions().map(option =>
        `${goalOptionName(option)}${option.matches(".is-disabled,[aria-disabled='true'],[disabled]") ? "（网页禁用）" : ""}`).join("、") || "没有可见选项"}。如果截图中存在此项，请提供该选项的 HTML。`);
    }
  }

  function goalMousePosition(element, label) {
    if (!element || !visible(element)) throw new Error(`未找到可见的${label}控件。`);
    element.scrollIntoView({block:"nearest",inline:"nearest"});
    const rect = element.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    const hit = document.elementFromPoint(x, y);
    if (rect.width < 6 || rect.height < 6 || x < 0 || y < 0 ||
        x >= innerWidth || y >= innerHeight)
      throw new Error(`${label}不在可点击区域。`);
    if (hit !== element && !element.contains(hit))
      throw new Error(`${label}被其他元素遮挡，已停止原生鼠标点击。`);
    return {x,y};
  }

  async function goalSettled(check) {
    // 一次普通点击后，允许 Vue/Element Plus 的更新周期完成；
    // 此处绝不启用 Chrome debugger。
    if (check()) return true;
    for (let i = 0; i < 4; i++) {
      await delay(90);
      assertNotStopped();
      if (check()) return true;
    }
    return false;
  }

  async function chooseGoal(value, runId) {
    // 已经选中目标时绝不能再次点击下拉框：点击已打开的控件会将菜单关闭。
    if (goalSelected(value)) return;
    if (!runId) throw new Error("缺少当前任务标识，不能执行优化目标点击。");
    say("正在展开优化目标菜单…");
    if (!goalOptions().length) {
      const field = document.querySelector("#cvType .el-select__wrapper");
      // 先尝试普通点击。有效时完全跳过 debugger，不产生调试提示条。
      click(field);
      if (!(await goalSettled(() => goalOptions().length > 0))) {
        await rpc("VPE_SELECT_GOAL", {
          id: runId, goal: value, action: "open",
          point: goalMousePosition(field, "优化目标选择框")
        });
      }
    }
    // 下拉框展开、动画等待均由普通 DOM 完成，期间 Chrome 调试器已断开。
    await until(() => goalOptions().length > 0, 5500, "优化目标下拉选项");
    await waitForGoalOption(value);
    await delay(140);
    let matches = selectableGoalOptions().filter(option => goalOptionName(option) === clean(value));
    if (matches.length !== 1) throw new Error(`优化目标「${value}」在弹层动画后不再唯一，请重新开始。`);
    say("正在点击优化目标选项…");
    click(matches[0]);
    if (await goalSettled(() => goalSelected(value))) return;
    // 少数 vivo 组件拒绝非可信点击：菜单若已关闭，必须重新展开后再原生点击；
    // 不能继续使用旧坐标，也不能点击失效的隐藏下拉项。
    if (!goalOptions().length) {
      const field = document.querySelector("#cvType .el-select__wrapper");
      await rpc("VPE_SELECT_GOAL", {
        id: runId, goal: value, action: "open",
        point: goalMousePosition(field, "优化目标选择框")
      });
      await waitForGoalOption(value);
      await delay(140);
    }
    matches = selectableGoalOptions().filter(option => goalOptionName(option) === clean(value));
    if (matches.length !== 1) throw new Error(`重新展开后无法唯一定位优化目标「${value}」。`);
    await rpc("VPE_SELECT_GOAL", {
      id: runId, goal: value, action: "choose",
      point: goalMousePosition(matches[0], "优化目标选项")
    });
    await until(() => goalSelected(value), 4500, `优化目标「${value}」选中回显`);
  }

  async function chooseOption(label, value, { prefix = false } = {}) {
    if (label === "优化目标") return chooseGoal(value);
    const field = selectionControl(label);
    if (!field) throw new Error(`未找到「${label}」下拉框。`);
    click(field);
    const option = await until(() => menuOption(value, { prefix }), 7000, `${label}选项「${value}」`);
    click(option);
    await delay(250);
  }

  function fieldTextMatches(label, expected) {
    const field = nearestControl(label, "input:not([type=checkbox]),[role=combobox],[class*='select']");
    return field && (clean(field.value).includes(clean(expected)) || clean(field.textContent).includes(clean(expected)));
  }

  function planFormReady() {
    // 已根据 vivo 新版实际 Elements 截图确认的结构：
    // #allFormId → #tab-pane-add → h3「投放内容与目标」→ #contentAndTargetId。
    const root = document.querySelector("#allFormId");
    const pane = document.querySelector("#tab-pane-add");
    const content = document.querySelector("#contentAndTargetId");
    if (root && pane && content && root.contains(content) &&
        pane.getAttribute("aria-hidden") !== "true" && visible(content)) return true;

    // 兼容未来 class/id 微调：不依赖搜索整页所有 div 的文本。
    return [...document.querySelectorAll("h3,h2,h4")].some(el =>
      visible(el) && within(el.textContent, "投放内容与目标") &&
      !!el.closest("form,.el-form,#allFormId"));
  }

  async function chooseAppAndCategory(payload) {
    say("正在选择应用、行业和产品…");
    await chooseOption("应用", payload.appName, { prefix: true });
    await delay(250);
    const picker = selectionControl("行业/产品");
    if (!picker) throw new Error("未找到行业/产品级联选择框。");
    click(picker);

    // The first column contains the industry branch, second contains the exact product.
    const branch = await until(() => menuOption(payload.industry), 7000, `行业「${payload.industry}」`);
    click(branch);
    await delay(300);
    const productTail = payload.product.includes("-") ? payload.product.slice(payload.product.indexOf("-") + 1) : payload.product;
    const product = await until(() => menuOption(payload.product) || menuOption(productTail),
      7000, `产品「${payload.product}」`);
    click(product);
    await delay(250);
  }

  async function chooseSegment(label, choice) {
    const item = formItem(label);
    const radio = item && [...item.querySelectorAll("label.el-radio-button")]
      .find(el => within(el.textContent, choice));
    if (radio && visible(radio)) {
      if (!radio.classList.contains("is-active")) click(radio);
      await until(() => radio.classList.contains("is-active"), 1600, `「${label} → ${choice}」选中状态`);
      return;
    }
    const labelNode = textNode(label);
    if (!labelNode) throw new Error(`未找到设置项「${label}」。`);
    const candidates = leavesWithText(choice).filter(el => {
      const a = labelNode.getBoundingClientRect();
      const b = el.getBoundingClientRect();
      return Math.abs(a.top - b.top) < 65 && b.left > a.left;
    });
    if (!candidates.length) throw new Error(`未找到「${label} → ${choice}」选项。`);
    click(candidates[0].closest("button,label,[role=radio]") || candidates[0]);
    await delay(180);
  }

  async function configurePlan(payload, runId) {
    if (!planFormReady()) throw new Error("当前不是新版的推广计划填写页面。");
    if (!textNode("应用推广")) throw new Error("未找到「应用推广」推广目标。");
    await configureTraffic(payload.traffic);
    await chooseAppAndCategory(payload);
    say("正在设置定向与优化目标…");
    await chooseSegment("安装定向", payload.install);
    await chooseGoal(payload.goal, runId);
    await fillBid(payload.bid);
    await fillByLabel("广告计划名称", payload.planName, "输入广告计划名称");
  }

  function getSaveButton() {
    return leavesWithText("保存并新建广告").find(el => el.closest("button"))?.closest("button") || null;
  }

  function adFormReady() {
    return !!(textNode("推广身份") && textNode("头像") && textNode("基础素材", { contains: true }));
  }

  function makeStatus() {
    if (statusHost) return;
    statusHost = document.createElement("div");
    statusHost.id = "vpe-execution-status";
    statusRoot = statusHost.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host{all:initial;position:fixed;right:18px;bottom:20px;z-index:2147483647;font:13px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;color:#283044}
      .box{width:min(390px,calc(100vw - 36px));padding:14px 16px;background:#fff;border:1px solid #dfe6f4;border-radius:10px;box-shadow:0 8px 34px #0002}
      .titlebar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:9px}
      .title{font-weight:600;color:#405ef8}.message{line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere}
      button.dismiss{border:0;background:transparent;color:#68738a;font-size:20px;line-height:1;padding:0 3px}
      button.dismiss:hover{color:#1f2937}
      .actions{display:flex;gap:8px;justify-content:flex-end;margin-top:10px}
      button{font:inherit;border-radius:6px;padding:7px 12px;border:1px solid #d9deec;background:#fff;cursor:pointer}
      button.primary{background:#4964ff;color:#fff;border-color:#4964ff}
    `;
    const box = document.createElement("div");
    box.className = "box";
    const heading = document.createElement("div");
    heading.className = "titlebar";
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = "vivo 广告计划助手";
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "dismiss";
    dismiss.textContent = "×";
    dismiss.setAttribute("aria-label", "停止任务并关闭提示");
    dismiss.addEventListener("click", () => { void stopCurrentTask(); });
    heading.append(title, dismiss);
    const message = document.createElement("div");
    message.className = "message";
    message.id = "message";
    const actions = document.createElement("div");
    actions.className = "actions";
    actions.id = "actions";
    box.append(heading, message, actions);
    statusRoot.append(style, box);
    document.documentElement.appendChild(statusHost);
  }

  function say(message, { error = false, paused = false } = {}) {
    assertNotStopped();
    makeStatus();
    const prefix = currentRun?.batchId ?
      `计划 ${currentRun.batchIndex + 1}/${currentRun.batchTotal} · ${currentRun.payload.planName}\n` : "";
    const fullMessage = prefix + message;
    statusRoot.querySelector("#message").textContent = fullMessage;
    lastErrorText = error ? fullMessage : "";
    const actions = statusRoot.querySelector("#actions");
    actions.replaceChildren();
    if (error) actions.appendChild(actionButton("复制错误", () => { void copyError(); }));
    if (paused) actions.appendChild(actionButton("继续任务", () => { void resumePausedTask(); }, true));
    actions.appendChild(actionButton("停止任务", () => { void stopCurrentTask(); }, !paused));
  }

  function actionButton(label, onClick, primary = false) {
    const button = document.createElement("button");
    button.textContent = label;
    button.type = "button";
    if (primary) button.className = "primary";
    button.addEventListener("click", onClick);
    return button;
  }

  async function copyError() {
    if (!lastErrorText) return;
    const value = lastErrorText;
    try {
      await navigator.clipboard.writeText(value);
      const button = statusRoot?.querySelector("#actions button");
      if (button) button.textContent = "已复制";
    } catch (error) {
      console.warn("[VPE] 复制错误失败", error);
      const button = statusRoot?.querySelector("#actions button");
      if (button) button.textContent = "复制失败";
    }
  }

  async function stopCurrentTask() {
    const run = currentRun;
    if (run?.id) stoppedRunIds.add(run.id);
    try {
      if (run) {
        const response = await chrome.runtime.sendMessage({
          type: "VPE_STOP_RUN", id: run.id, batchId: run.batchId,
          sourceTabId: run.sourceTabId
        });
        if (!response?.ok) throw new Error(response?.error || "无法结束当前任务");
      }
      window.VPContent?.resetDraft?.();
      removeStatus();
    } catch (error) {
      if (run?.id) stoppedRunIds.delete(run.id);
      say(`停止任务失败：${error.message}`, {error:true});
    }
  }

  async function rpc(type, args = {}) {
    assertNotStopped();
    const result = await chrome.runtime.sendMessage({ type, ...args });
    assertNotStopped();
    if (!result?.ok) throw new Error(result?.error || "扩展状态同步失败");
    return result;
  }

  async function finish(run, message) {
    await rpc("VPE_END", { id: run.id });
    say(message);
  }

  function removeStatus() {
    statusHost?.remove();
    statusHost = null;
    statusRoot = null;
  }

  async function fail(run, error) {
    if (stoppedRunIds.has(run.id)) return;
    console.warn("[VPE] 自动化暂停", error);
    currentRun = run;
    try { await rpc("VPE_END", { id: run.id, error: error.message }); } catch {}
    if (run.batchId) {
      try { await globalThis.VPMediaStore?.deleteBatch(run.batchId); }
      catch (cleanupError) { console.warn("[VPE] 清理未完成的视频失败", cleanupError); }
    }
    say(`已停止自动执行：${error.message}\n\n${run.batchId ? `前 ${run.batchIndex} 个计划已确认提交，本计划及后续计划不会自动重试。\n\n` : ""}没有继续提交广告。请截图当前页面，并提供出错控件的「检查」HTML，我们再针对这个位置适配。`, {error:true});
  }

  function pageErrors() {
    const selectors = ".el-form-item__error,.ep-form-item__error,.el-message--error," +
      ".ep-message--error,.el-notification--error,.ep-notification--error,[role='alert']";
    return [...new Set([...document.querySelectorAll(selectors)]
      .filter(visible).map(el => String(el.textContent || "").trim()).filter(Boolean))].slice(0, 3);
  }

  async function pauseSubmission(run, checkpoint, reason) {
    const saved = await rpc("VPE_PAUSE_SUBMISSION", { id: run.id, checkpoint, error: reason });
    if (!saved.paused) throw new Error("后台未确认暂停提交任务。");
    currentRun = run;
    say(`提交步骤已暂停：${reason}\n\n请直接在当前页面人工修改，完成后点击「继续任务」。` +
      `扩展将从当前提交步骤继续，不会重新选择素材或覆盖人工修改的广告字段。` +
      `\n如果页面其实已经保存成功但没有跳转，请先核对，避免重复创建。`,
      { error: true, paused: true });
  }

  async function awaitSubmission(run, checkpoint) {
    const planSave = checkpoint === "plan-save";
    const expected = planSave ? adFormReady :
      () => location.pathname === "/marketing/newpromotion/advertisement";
    const end = Date.now() + (planSave ? 25000 : 22000);
    let firstError = "", firstErrorAt = 0;
    while (Date.now() < end) {
      assertNotStopped();
      if (expected()) return true;
      const details = pageErrors();
      const message = details.join("；");
      if (message) {
        if (message !== firstError) { firstError = message; firstErrorAt = Date.now(); }
        if (Date.now() - firstErrorAt >= 600) {
          await pauseSubmission(run, checkpoint, `平台提示：${message}`);
          return false;
        }
      } else { firstError = ""; firstErrorAt = 0; }
      await delay(250);
    }
    if (expected()) return true;
    const details = pageErrors();
    await pauseSubmission(run, checkpoint,
      details.length ? `平台提示：${details.join("；")}` :
      `点击「${planSave ? "保存并新建广告" : "提交并关闭"}」后未确认跳转，` +
      "可能有未通过的必填项，也可能仍在处理提交结果。");
    return false;
  }

  async function resumePausedTask() {
    if (active || !currentRun?.id) return;
    active = true;
    const prior = currentRun;
    let checkpoint = null;
    try {
      const { run } = await rpc("VPE_GET_RUN");
      if (!run || run.id !== prior.id) throw new Error("任务已经结束或已切换，不能重复提交。");
      checkpoint = run.stage === "paused-plan-save" ? "plan-save" :
        run.stage === "paused-ad-submit" ? "ad-submit" : null;
      if (!checkpoint) throw new Error("当前任务不是等待人工修复的提交阶段。");
      currentRun = run;

      if (checkpoint === "plan-save") {
        if (adFormReady()) {
          // 人工已经保存并进入广告编辑页面，直接继续广告阶段，不再保存计划。
          await rpc("VPE_STAGE", { id: run.id, stage: "await-ad" });
          say("检测到计划已经保存，继续广告素材和字段处理…");
          try { await adStage(run); } catch (error) { await fail(run, error); }
          return;
        }
        if (!planFormReady()) throw new Error("没有检测到原计划表单或已经打开的广告编辑页。");
        const button = getSaveButton();
        if (!button) throw new Error("未找到「保存并新建广告」按钮，请先检查页面。");
        await rpc("VPE_STAGE", { id: run.id, stage: "await-ad" });
        say("正在按人工修改后的内容重试一次「保存并新建广告」…");
        click(button);
        if (await awaitSubmission(run, checkpoint)) {
          try { await adStage(run); } catch (error) { await fail(run, error); }
        }
        return;
      }

      if (!adFormReady()) throw new Error("没有检测到当前广告编辑页面，不能重复提交。");
      const button = submitAndCloseButton();
      // 只重试最终提交，不覆盖人工修正过的标题/监测地址，不重新上传素材。
      await rpc("VPE_STAGE", { id: run.id, stage: "submitting-ad" });
      say("正在按人工修改后的内容重试一次「提交并关闭」…");
      click(button);
      await awaitSubmission(run, checkpoint);
    } catch (error) {
      if (stoppedRunIds.has(prior.id)) return;
      console.warn("[VPE] 人工修复后恢复提交失败：", error);
      if (checkpoint) {
        try { await pauseSubmission(prior, checkpoint, error.message); return; }
        catch (pauseError) { console.warn("[VPE] 重新暂停失败：", pauseError); }
      }
      say(`暂时无法继续任务：${error.message}\n请检查当前页面，任务仍保留。`,
        { error: true, paused: true });
    } finally { active = false; }
  }

  async function planStage(run) {
    if (active) return;
    active = true;
    currentRun = run;
    try {
      say("正在打开新建广告页面…");
      if (!planFormReady()) {
        const url = location.pathname;
        if (url.includes("/marketing/newpromotion/plan")) {
          // 首条与后续计划都由扩展后台直接创建新标签，绕开网页弹窗拦截。
          // 后台返回前会将当前任务绑定到新标签的真实 tabId。
          say("正在直接打开新建推广计划标签页…");
          const opened = await rpc("VPE_OPEN_PLAN_TAB", { id: run.id });
          if (!opened.opened || !Number.isInteger(opened.destinationTabId))
            throw new Error("没有获得已绑定当前任务的新建推广计划标签页。");
          say("已在新标签页打开新建推广计划，正在该页面继续执行。");
          return;
        } else if (!url.includes("/marketing/newads/add")) {
          throw new Error("请从新版广告计划列表页发起任务。");
        }
        say("已进入新标签页，正在等待新版推广计划表单渲染完成…");
        await until(planFormReady, 25000, "新建推广计划表单（#allFormId / #contentAndTargetId）");
      }

      await configurePlan(run.payload, run.id);
      const saveButton = getSaveButton();
      if (!saveButton) throw new Error("未找到「保存并新建广告」按钮。");

      await rpc("VPE_STAGE", { id: run.id, stage: "await-ad" });
      say("计划表单填写完成，正在直接保存并进入广告编辑页…");
      click(saveButton);
      if (await awaitSubmission(run, "plan-save")) await adStage(run);
    } catch (error) {
      await fail(run, error);
    } finally {
      active = false;
    }
  }

  async function uploadAvatarLocally(run) {
    const drawers = [...document.querySelectorAll(
      ".newads-app__material-upload-drawer.el-drawer.open[role='dialog']")].filter(visible);
    if (drawers.length !== 1) throw new Error("无法唯一识别当前头像素材抽屉，已停止本地上传。");
    const drawer = drawers[0];
    const tab = drawer.querySelector("#tab-localUpload[role='tab']");
    if (!tab || !visible(tab)) throw new Error("未找到头像素材抽屉中的「本地上传」标签。");
    if (!tab.classList.contains("is-active")) click(tab);
    const pane = await until(() => [...drawer.querySelectorAll(".local-upload-content")]
      .find(visible), 6000, "本地上传内容区（.local-upload-content）");
    const inputs = [...pane.querySelectorAll("input.el-upload__input[type='file']")];
    if (inputs.length !== 1) throw new Error(`本地上传文件输入框数量为 ${inputs.length}，无法安全指定头像。`);

    // 已保存到 chrome.storage.local 的头像是当前执行任务自带的 dataUrl，
    // 因此新标签页无需再打开文件选择器。通过真实的 file input change
    // 交给 vivo 页面现有的 Element Upload 处理上传。
    const avatar = run.payload?.avatar;
    const match = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(avatar?.dataUrl || "");
    if (!match || !/\.(png|jpe?g)$/i.test(avatar?.name || ""))
      throw new Error("保存的头像文件或格式无效，请在扩展里重新选择 JPG/PNG 头像。");
    const bytes = Uint8Array.from(atob(match[2]), char => char.charCodeAt(0));
    if (!bytes.length || bytes.length >= 50 * 1024)
      throw new Error("保存的头像文件必须小于 50KB，无法进行本地上传。");
    const file = new File([bytes], avatar.name, { type: match[1] });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const input = inputs[0];
    input.files = transfer.files;
    say(`已切换至「本地上传」，正在上传头像「${file.name}」…`);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));

    let selectedRowClicked = false;
    function uploadState() {
      const footer = drawer.querySelector(".drawer-footer-content");
      const selected = /已选择\s*1\s*\/\s*1/.test(footer?.textContent || "") &&
        footer.querySelectorAll(".cur-list .cur-wrapper").length === 1;
      if (selected) return { selected: true };

      // 若上传完成后出现可勾选的文件行，只能按完整文件名找到唯一一行。
      // 不点击「删除」等操作按钮，也不猜测其他素材。
      const list = pane.querySelector(".local-upload-list");
      const names = [...(list?.querySelectorAll("span,td,div,p") || [])].filter(el =>
        visible(el) && clean(el.textContent) === clean(file.name) &&
        ![...el.children].some(child => clean(child.textContent) === clean(file.name)));
      const rows = [...new Set(names.map(el =>
        el.closest("tr,.el-table__row,[class*='upload-item'],[class*='file-item'],[class*='upload-row']")))]
        .filter(Boolean);
      if (!selectedRowClicked && rows.length === 1) {
        const row = rows[0];
        const checkbox = [...row.querySelectorAll("label.el-checkbox")].filter(visible);
        if (checkbox.length === 1 && !checkbox[0].classList.contains("is-checked") &&
            !row.querySelector(".is-uploading,.el-progress")) {
          selectedRowClicked = true;
          click(checkbox[0]);
        }
      }
      return { selected: false, rowCount: rows.length,
        footer: clean(footer?.textContent || "").slice(0, 50) };
    }
    try {
      await until(() => uploadState().selected, 30000,
        "本地头像上传成功并进入「已选择1/1」列表");
    } catch {
      const state = uploadState();
      throw new Error(`本地上传后尚未选中头像（文件行${state.rowCount || 0}条，底部「${state.footer || "无"}」）。请截图上传后的列表与按钮 HTML。`);
    }
    say("本地上传的头像已进入素材抽屉的已选列表，准备确认…");
  }

  async function chooseAvatar(run) {
    say("正在使用已验证过的头像入口定位方式打开素材库…");
    // 恢复 V0.2.8 已经实际打开过素材库的定位逻辑。
    // 曾误改为寻找 .square-div/.img-template，后来又改为点击外层容器、浏览器级点击。
    const label = textNode("头像");
    if (!label) throw new Error("未找到头像区域。");
    const labelRect = label.getBoundingClientRect();
    const clickable = [...document.querySelectorAll("button,[role=button],[class*='upload'],[class*='Upload']")]
      .filter(visible)
      .map(el => ({el,rect:el.getBoundingClientRect()}))
      .filter(x => x.rect.left > labelRect.right && x.rect.left < labelRect.right + 560 &&
        x.rect.top >= labelRect.top - 30 && x.rect.top < labelRect.top + 200)
      .sort((a,b) => Math.abs(a.rect.top - labelRect.top - 12) -
        Math.abs(b.rect.top - labelRect.top - 12));
    if (!clickable.length) throw new Error("未找到头像上传入口「+」。");
    click(clickable[0].el);
    await until(() => textNode("我的素材") || textNode("本地上传"), 8000, "头像素材侧边栏");
    if (!document.querySelector("#promotionAvatar .avatar-upload-class"))
      throw new Error("未找到广告页 #promotionAvatar 头像组件。");
    say("正在素材库中定位并勾选保存的头像…");
    const selected = await rpc("VPE_MATERIAL_SELECT", { id: run.id });
    if (selected.notFound) {
      say("素材库没有找到匹配的头像，正在改用本地上传…");
      await uploadAvatarLocally(run);
    } else {
      if (!selected.selected) throw new Error("素材库未确认头像已选中。");
      if (selected.matchMode === "only-item") {
        say(`本地头像文件名与素材库名称不同；素材库只有一条记录，已勾选「${selected.name}」，正在确认…`);
      }
    }
    say("头像已在素材库中勾选，正在确认并核对广告页预览…");
    // 实际页面结构：素材卡片位于 adcc 子 iframe；「已选择1/1」及
    // .drawer-footer-btn 的「确认」按钮位于广告页的 iframe 外部。
    // 因此必须由当前广告页点击，而不是让素材 iframe 寻找该按钮。
    function confirmationState() {
      // 限定在用户截图里正在打开的 .newads-app__material-upload-drawer，
      // 避免页面内其他抽屉的同名 footer 导致此前 footers.length !== 1。
      const drawers = [...document.querySelectorAll(
        ".newads-app__material-upload-drawer.el-drawer.open[role='dialog']")]
        .filter(visible);
      const drawer = drawers.length === 1 ? drawers[0] : null;
      const footer = drawer?.querySelector(".drawer-footer-content");
      const countText = footer?.textContent || "";
      const previews = footer?.querySelectorAll(".cur-list .cur-wrapper").length || 0;
      const buttons = [...(drawer?.querySelectorAll(
        ".drawer-footer-btn button.el-button--primary") || [])]
        .filter(btn => visible(btn) && clean(btn.textContent) === "确认" &&
          !btn.disabled && btn.getAttribute("aria-disabled") !== "true");
      return {
        button: drawer && /已选择\s*1\s*\/\s*1/.test(countText) &&
          previews === 1 && buttons.length === 1 ? buttons[0] : null,
        details: `打开抽屉${drawers.length}个，已选文案「${clean(countText).slice(0,30)}」，` +
          `预览${previews}张，确认按钮${buttons.length}个`
      };
    }
    let confirmation;
    try {
      confirmation = await until(() => confirmationState().button, 10000,
        "当前素材抽屉的「已选择1/1」及「确认」按钮");
    } catch {
      throw new Error(`未能确认当前素材抽屉的选择及确认按钮（${confirmationState().details}）。`);
    }
    click(confirmation);

    // 用户提供的真实 DOM：#promotionAvatar > .avatar-upload-class
    //   > .img-template > .square-div > img[src]。只以广告编辑页面的图片回显判成功。
    await until(() => {
      // Vue 可能在确认后替换整个头像组件，每次重新取当前 DOM。
      const image = document.querySelector(
        "#promotionAvatar .avatar-upload-class .img-template .square-div img[src]");
      return image?.complete && image.naturalWidth > 0 ? image : null;
    }, 16000, "广告页已加载完成的头像预览图");
  }

  async function selectPromoName(name) {
    say("正在核对推广名称…");
    const selected = nearestControl("推广名称", "input:not([type=checkbox]),[role=combobox]");
    if (selected && clean(selected.value || selected.textContent).includes(clean(name))) return;
    await chooseOption("推广名称", name, { prefix: true });
  }

  async function uploadBasicImages(run) {
    const mediaType = run.payload?.mediaType;
    const video = mediaType?.startsWith("视频");
    if (!["单图 16:9", "单图 9:16", "视频 16:9", "视频 9:16"].includes(mediaType))
      throw new Error("当前任务的基础素材类型无效，无法继续上传。");
    const count = run.payload?.mediaCount;
    if (!Number.isInteger(count) || count < 1 || count > 5)
      throw new Error("当前任务没有有效的基础素材配置，无法继续上传。");
    // 用户提供的实际 HTML：尺寸入口是 span.el-tag.required-item-tag.is-click，
    // 标签里分开渲染「单图 16:9」和「添加」，不是一个文字为「添加单图」的按钮。
    const sizeTags = [...document.querySelectorAll("span.el-tag.required-item-tag.is-click")]
      .filter(visible).filter(tag => [...tag.querySelectorAll(".el-tag__content > span")]
        .some(label => within(label.textContent, mediaType)));
    if (sizeTags.length !== 1)
      throw new Error(`未找到唯一的「${mediaType}」可点击尺寸标签（.required-item-tag.is-click）。`);
    say(`头像完成，正在点击「${mediaType}」素材尺寸标签（共 ${count} 个）…`);
    click(sizeTags[0]);

    const drawer = await until(() => {
      const open = [...document.querySelectorAll(
        ".newads-app__material-upload-drawer.el-drawer.open[role='dialog']")].filter(visible);
      return open.length === 1 ? open[0] : null;
    }, 9000, "基础素材选择抽屉");
    const tab = drawer.querySelector("#tab-localUpload[role='tab']");
    if (!tab || !visible(tab)) throw new Error("基础素材抽屉中未找到「本地上传」标签。");
    if (!tab.classList.contains("is-active")) click(tab);
    const pane = await until(() => [...drawer.querySelectorAll(".local-upload-content")]
      .find(visible), 6000, "基础素材本地上传页面");
    const inputs = [...pane.querySelectorAll("input.el-upload__input[type='file']")];
    if (inputs.length !== 1 || (count > 1 && !inputs[0].multiple))
      throw new Error("未找到与素材数量匹配的基础素材上传文件框（多文件需要支持多选）。");
    const filenames = new Set();
    if (!run.batchId || !globalThis.VPMediaStore)
      throw new Error("无法访问本地素材文件句柄库，请返回批量创建页面重新选择文件。");
    const files = await globalThis.VPMediaStore.getFiles(
      run.batchId, run.batchIndex, count, run.payload.mediaMeta
    );
    if (files.length !== count) throw new Error("基础素材文件数量与任务不一致。");
    if (files.some(file => video ?
      !file.type.startsWith("video/") || !/\.(mp4|mov|webm)$/i.test(file.name) :
      !["image/png", "image/jpeg"].includes(file.type) ||
        !/\.(jpe?g|png)$/i.test(file.name) || file.size > 300 * 1024))
      throw new Error("基础素材类型或大小不符合任务要求，请重新选择。");
    for (const file of files) {
      if (filenames.has(file.name)) throw new Error(`基础素材有同名文件「${file.name}」，无法核验上传对象。`);
      filenames.add(file.name);
    }
    const transfer = new DataTransfer();
    files.forEach(file => transfer.items.add(file));
    const input = inputs[0];
    input.files = transfer.files;
    say(`已选择「本地上传」，正在发送 ${files.length} 个「${mediaType}」${video ? "视频" : "图片"}…`);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));

    const clickedRows = new Set();
    function uploadState() {
      const footer = drawer.querySelector(".drawer-footer-content");
      const countText = footer?.textContent || "";
      const previewCount = footer?.querySelectorAll(".cur-list .cur-wrapper").length || 0;
      if (new RegExp(`已选择\\s*${files.length}\\s*\\/\\s*5`).test(countText) &&
          previewCount === files.length) return { complete: true, countText, previewCount };

      // 平台若未自动勾选上传完成的文件，则只选中与本次文件名完全一致的行。
      const list = pane.querySelector(".local-upload-list");
      const rows = [...(list?.querySelectorAll("tr.el-table__row") || [])].filter(visible);
      for (const file of files) {
        if (clickedRows.has(file.name)) continue;
        const matches = rows.filter(row => [...row.querySelectorAll("span,div,td")]
          .some(node => clean(node.textContent) === clean(file.name)));
        if (matches.length !== 1) continue;
        const row = matches[0];
        const checkboxes = [...row.querySelectorAll("label.el-checkbox")].filter(visible);
        if (checkboxes.length === 1 && !checkboxes[0].classList.contains("is-checked") &&
            !row.querySelector(".is-uploading,.el-progress")) {
          clickedRows.add(file.name);
          click(checkboxes[0]);
        }
      }
      return { complete: false, countText, previewCount, rows: rows.length };
    }
    try {
      await until(() => uploadState().complete, video ? 180000 : 45000,
        `基础素材上传并全部勾选（已选择${files.length}/5）`);
    } catch {
      const state = uploadState();
      throw new Error(`基础素材尚未全部选中：抽屉显示「${clean(state.countText).slice(0,30)}」，` +
        `已选预览${state.previewCount}个，上传列表${state.rows || 0}行。请截图该列表的 HTML。`);
    }

    const confirmations = [...drawer.querySelectorAll(".drawer-footer-btn button.el-button--primary")]
      .filter(button => visible(button) && clean(button.textContent) === "确认" &&
        !button.disabled && button.getAttribute("aria-disabled") !== "true");
    if (confirmations.length !== 1) throw new Error("基础素材已选中，但没有唯一可用的「确认」按钮。");
    say(`已勾选 ${files.length} 个素材，正在确认并核验广告页数量…`);
    click(confirmations[0]);
    await until(() => [...document.querySelectorAll("h2,h3,div,span")].some(el => {
      if (!visible(el)) return false;
      const caption = clean(el.textContent);
      if (caption.length > 60) return false;
      const match = caption.match(/^基础素材[（(](\d+)\/5[）)]$/);
      return match && Number(match[1]) === files.length;
    }), 18000, `广告页「基础素材(${files.length}/5)」回显`);
  }

  async function adStage(run) {
    currentRun = run;
    if (!adFormReady()) throw new Error("当前没有检测到广告页的头像区域。");
    await selectPromoName(run.payload.promoName);
    await chooseAvatar(run);
    await uploadBasicImages(run);
    await fillAdFieldsAndSubmit(run);
  }

  async function adField(selector, label, value, required = false) {
    if (!required && !String(value || "").trim()) return;
    if (required && !String(value || "").trim()) throw new Error(`「${label}」不能为空。`);
    const inputs = [...document.querySelectorAll(selector)].filter(visible);
    if (inputs.length !== 1) throw new Error(`未找到唯一的「${label}」输入框（找到 ${inputs.length} 个）。`);
    nativeSet(inputs[0], value);
    await delay(200);
    if (inputs[0].value.trim() !== String(value).trim())
      throw new Error(`「${label}」输入后没有正确回显，已停止提交。`);
  }

  function submitAndCloseButton() {
    // “提交并继续新建”也属于 primary，必须只按完整按钮文字找。
    const buttons = [...document.querySelectorAll(".bottom-btns button.el-button")]
      .filter(button => visible(button) && clean(button.textContent) === "提交并关闭" &&
        !button.disabled && button.getAttribute("aria-disabled") !== "true");
    if (buttons.length !== 1) throw new Error(`未找到唯一可用的「提交并关闭」按钮（找到 ${buttons.length} 个）。`);
    return buttons[0];
  }

  async function fillAdFieldsAndSubmit(run) {
    const payload = run.payload || {};
    const headline = String(payload.headline || "").trim();
    if (headline.length < 6 || headline.length > 15)
      throw new Error("广告标题必须为 6～15 个字符，已停止提交。");
    const adName = String(payload.adName || payload.planName || "").trim();
    if (!adName || adName.length > 200) throw new Error("广告名称不能为空且不能超过 200 个字符。");

    say("基础素材已确认，正在填写广告标题和其余广告字段…");
    // vivo 的标题子表单 ID 会随渲染变成 titleList0/titleList1 等，不能固定为 #titleList。
    // 用户提供的真实结构中外层 #title 稳定，标题输入框具有“请输入标题”占位符。
    await adField('#title input.el-input__inner[placeholder="请输入标题"]', "广告标题", headline, true);
    await adField("#deepLink input.el-input__inner", "DeepLink", payload.deepLink);
    await adField("#viewMonitorUrl input.el-input__inner", "曝光监测地址", payload.viewMonitorUrl);
    await adField("#clickMonitorUrl input.el-input__inner", "点击监测地址", payload.clickMonitorUrl);
    await adField("#name textarea.el-textarea__inner", "广告名称", adName, true);
    const button = submitAndCloseButton();

    // 先记录提交状态，再点按钮；跳到广告列表后后台才能准确识别并回到计划页。
    await rpc("VPE_STAGE", { id: run.id, stage: "submitting-ad" });
    say("所有已配置字段填写完成，正在点击「提交并关闭」并等待广告列表跳转…");
    click(button);

    // 错误和超时变为可人工修正的检查点，不结束批次、不删除素材。
    // 真正跳转成功仍由 background.js 判断，避免仅凭按钮点击判定成功。
    await awaitSubmission(run, "ad-submit");
  }

  async function resumeAfterPageLoad() {
    try {
      const { run } = await rpc("VPE_GET_RUN");
      if (!run) {
        if (location.pathname === "/marketing/newpromotion/plan" && !active) {
          currentRun = null;
          const { result } = await rpc("VPE_BATCH_RESULT");
          if (result) {
            if (result.batchId) {
              try { await globalThis.VPMediaStore?.deleteBatch(result.batchId); }
              catch (error) { console.warn("[VPE] 批量结束后清理视频失败", error); }
            }
            if (result.status === "completed") {
              // 后台已清除批次和运行状态；成功结果也已被 VPE_BATCH_RESULT 消费。
              // 不显示需要人工点击“停止任务”的完成弹框，清空本次临时表单即可。
              lastErrorText = "";
              window.VPContent?.resetDraft?.();
              removeStatus();
            } else {
              say(`批量创建已停止：成功 ${result.completed}/${result.total} 个；第 ${result.failedIndex + 1} 个计划未完成。\n${result.error}\n后续计划未执行。`, {error:true});
            }
          }
        }
        return;
      }
      if (active) return;
      if (["paused-plan-save", "paused-ad-submit"].includes(run.stage)) {
        currentRun = run;
        say(`提交步骤已暂停：${run.pauseReason || "等待人工修正页面错误"}\n\n` +
          "请在本页面修正后点击「继续任务」，也可以点击「停止任务」结束整个批次。",
          { error: true, paused: true });
      } else if (run.stage === "plan" && (location.pathname.includes("/marketing/newads/add") ||
          location.pathname.includes("/marketing/newpromotion/plan"))) {
        void planStage(run);
      } else if (run.stage === "await-ad") {
        if (active) return;
        active = true;
        try {
          if (adFormReady() || await awaitSubmission(run, "plan-save")) await adStage(run);
        } catch (error) { await fail(run, error); }
        finally { active = false; }
      } else if (run.stage === "submitting-ad") {
        // 重新载入时不重按提交按钮，只观察原来的结果或暂停让人确认。
        if (active) return;
        active = true;
        try { await awaitSubmission(run, "ad-submit"); }
        catch (error) { await fail(run, error); }
        finally { active = false; }
      }
    } catch (error) {
      console.debug("[VPE] 暂无可恢复任务：", error.message);
    }
  }

  window.VPWorkflow = { start: planStage };
  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === "VPE_RESUME") void resumeAfterPageLoad();
    if (message?.type === "VPE_STOP_SIGNAL") {
      if (message.runId) stoppedRunIds.add(message.runId);
      removeStatus();
    }
  });
  void resumeAfterPageLoad();
  if (location.pathname.includes("/marketing/newads/add")) {
    // opener 被 noopener 隐藏时，后台可能稍晚关联标签页，短时轮询兜底。
    for (const ms of [600, 1500, 3000, 5000, 8000]) {
      setTimeout(() => { if (!active) void resumeAfterPageLoad(); }, ms);
    }
  }
})();
