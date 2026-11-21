(() => {
  "use strict";

  if (window.top !== window || window.__vivoPlanAssistantInstalled) return;
  window.__vivoPlanAssistantInstalled = true;

  const STORAGE_KEY = "vivoPlanAssistantCatalogV1";
  const AVATAR_KEY = "vivoPlanAssistantDefaultAvatarV1";
  const TRAFFIC_GROUPS = [
    { name: "商店", items: ["推荐列表", "首页banner", "搜索推广"] },
    { name: "非商店", items: ["信息流"] },
    { name: "联盟", items: ["原生", "激励视频", "插屏", "开屏", "BANNER"] }
  ];
  const GOALS = ["下载", "新增激活", "自定义付费", "自定义激活", "自定义拉活", "自定义注册"];
  const MEDIA_TYPES = ["单图 16:9", "单图 9:16", "视频 16:9", "视频 9:16"];
  const MAX_MEDIA_FILES = 5;
  const MAX_PLANS = 10;
  const makePlan = () => ({ id: newId(), planName: "", traffic: new Set(), mediaType: "", media: [] });

  const state = {
    associations: [],
    promoNames: [],
    defaultAssociationId: null,
    defaultPromoName: null,
    plans: [],
    avatar: null,
    avatarData: null,
    appManagerOpen: false,
    nameManagerOpen: false,
    submitting: false,
    loaded: false
  };

  let host;
  let shadow;
  let previousFocus;

  const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);

  async function loadCatalog() {
    if (state.loaded) return;
    try {
      const result = await chrome.storage.local.get(STORAGE_KEY);
      const catalog = result[STORAGE_KEY];
      if (catalog && typeof catalog === "object") {
        if (Array.isArray(catalog.associations)) {
          state.associations = catalog.associations.filter(a =>
            typeof a?.id === "string" && typeof a.app === "string" &&
            typeof a.industry === "string" && typeof a.product === "string"
          );
        }
        if (Array.isArray(catalog.promoNames)) {
          state.promoNames = [...new Set(catalog.promoNames.filter(n => typeof n === "string" && n.trim()))];
        }
        state.defaultAssociationId = state.associations.some(a => a.id === catalog.defaultAssociationId) ?
          catalog.defaultAssociationId : null;
        state.defaultPromoName = state.promoNames.includes(catalog.defaultPromoName) ?
          catalog.defaultPromoName : null;
      }
      const avatarRecord = (await chrome.storage.local.get(AVATAR_KEY))[AVATAR_KEY];
      if (avatarRecord && /^data:image\/(png|jpeg);base64,/.test(avatarRecord.dataUrl || "")) {
        state.avatarData = avatarRecord;
        state.avatar = fileFromDataUrl(avatarRecord);
      }
    } catch (error) {
      console.warn("[vivo 广告计划助手] 加载本地选项失败", error);
    }
    state.loaded = true;
  }

  function fileFromDataUrl(record) {
    const [header, base64] = record.dataUrl.split(",");
    const mime = header.match(/^data:(.*);base64$/)?.[1] || "image/png";
    const data = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    return new File([data], record.name, { type: mime });
  }

  function dataUrlFromFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("无法保存头像文件"));
      reader.readAsDataURL(file);
    });
  }

  async function saveCatalog() {
    try {
      await chrome.storage.local.set({
        [STORAGE_KEY]: {
          associations: state.associations,
          promoNames: state.promoNames,
          defaultAssociationId: state.defaultAssociationId,
          defaultPromoName: state.defaultPromoName
        }
      });
    } catch (error) {
      console.error("[vivo 广告计划助手] 保存本地选项失败", error);
      showNotice("本地保存失败，请检查扩展权限。", true);
    }
  }

  function newId() {
    return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  }

  function option(value, label = value) {
    const element = document.createElement("option");
    element.value = value;
    element.textContent = label;
    return element;
  }

  function template() {
    return `
      <div class="vp-backdrop" data-action="backdrop">
        <section class="vp-modal" role="dialog" aria-modal="true" aria-labelledby="vp-title" tabindex="-1">
          <header class="vp-header">
            <div class="vp-heading"><h1 id="vp-title">批量新建广告</h1><span class="vp-badge">最多10个计划</span></div>
            <button type="button" class="vp-icon-button" data-action="close" aria-label="关闭弹窗">×</button>
          </header>
          <form id="vp-form" novalidate>
            <main class="vp-body">
              <div class="vp-section-heading"><strong>广告计划配置</strong><small>每个计划单独选择名称、流量、素材类型和本地素材</small></div>
              <div id="vp-plan-list" class="vp-plan-list"></div>
              <button type="button" class="vp-button vp-add-plan" data-action="add-plan">＋ 新增广告计划</button>
              <div class="vp-section-heading vp-common-heading"><strong>公共参数设计</strong><small>以下设置对本次创建的所有计划生效</small></div>
              <div class="vp-field">
                <label class="vp-label" for="vp-app">应用 <em>*</em></label>
                <div class="vp-control"><select id="vp-app"><option value="">请选择应用</option></select></div>
                <button type="button" class="vp-button vp-outline vp-manage-btn" data-action="toggle-app-manager" aria-expanded="false">⚙ 管理应用</button>
              </div>
              <div class="vp-field">
                <label class="vp-label" for="vp-product">行业/产品 <em>*</em></label>
                <div class="vp-control"><select id="vp-product"><option value="">请选择行业/产品</option></select></div>
                <span class="vp-trailing-spacer"></span>
              </div>
              <div id="vp-app-manager" class="vp-manager" hidden>
                <div class="vp-manager-heading">管理应用及行业/产品</div>
                <div class="vp-manager-subheading">已添加的应用关联</div>
                <div id="vp-app-list" class="vp-list"></div>
                <div class="vp-manager-separator"></div>
                <div class="vp-manager-subheading">新增应用关联</div>
                <div class="vp-field vp-manager-row"><label class="vp-label" for="vp-new-app">应用名称</label><div class="vp-control"><input id="vp-new-app" placeholder="输入应用名称" maxlength="120"></div></div>
                <div class="vp-manager-double">
                  <label for="vp-new-industry">行业</label><input id="vp-new-industry" placeholder="输入行业" maxlength="100">
                  <label for="vp-new-product">产品</label><input id="vp-new-product" placeholder="输入产品" maxlength="160">
                </div>
                <div class="vp-manager-actions"><button type="button" class="vp-button vp-primary" data-action="add-association">＋ 添加关联</button></div>
              </div>

              <div class="vp-rule"></div>
              <div class="vp-field">
                <span class="vp-label">安装定向</span>
                <div class="vp-control vp-inline-radios" id="vp-install" role="radiogroup" aria-label="安装定向">
                  <label class="vp-check"><input type="radio" name="vp-install" value="不限"><span>不限</span></label>
                  <label class="vp-check"><input type="radio" name="vp-install" value="未安装"><span>未安装</span></label>
                  <label class="vp-check"><input type="radio" name="vp-install" value="已安装" checked><span>已安装</span></label>
                </div>
              </div>
              <div class="vp-two-column">
                <div class="vp-field">
                  <label class="vp-label" for="vp-goal">优化目标 <em>*</em></label>
                  <div class="vp-control"><select id="vp-goal">${GOALS.map(g => `<option${g === "自定义拉活" ? " selected" : ""}>${g}</option>`).join("")}</select></div>
                </div>
                <div class="vp-field vp-bid-field">
                  <label class="vp-label" for="vp-bid">出价金额 <em>*</em></label>
                  <div class="vp-control"><input id="vp-bid" type="number" min="0.01" step="0.01" inputmode="decimal" value="0.1" placeholder="请输入金额"></div>
                  <span class="vp-unit">元/转化</span>
                </div>
              </div>

              <div class="vp-rule"></div>
              <div class="vp-field">
                <label class="vp-label" for="vp-promo">推广名称 <em>*</em></label>
                <div class="vp-control"><select id="vp-promo"><option value="">请选择推广名称</option></select></div>
                <button type="button" class="vp-button vp-outline vp-manage-btn" data-action="toggle-name-manager" aria-expanded="false">⚙ 管理推广名称</button>
              </div>
              <div id="vp-name-manager" class="vp-manager" hidden>
                <div class="vp-manager-heading">管理推广名称</div>
                <div class="vp-manager-subheading">已添加的推广名称</div>
                <div id="vp-name-list" class="vp-list"></div>
                <div class="vp-manager-separator"></div>
                <div class="vp-field vp-manager-row">
                  <label class="vp-label" for="vp-new-name">新增推广名称</label>
                  <div class="vp-control"><input id="vp-new-name" maxlength="200" placeholder="输入推广名称"></div>
                  <button type="button" class="vp-button vp-primary" data-action="add-name">＋ 添加名称</button>
                </div>
              </div>

              <div class="vp-field">
                <span class="vp-label">头像 <em>*</em></span>
                <div class="vp-control"><input id="vp-avatar-display" readonly placeholder="尚未选择头像图片" aria-label="已选择的头像文件"></div>
                <button type="button" class="vp-button vp-outline vp-file-button" data-action="choose-avatar">▧ 选择图片</button>
                <input type="file" id="vp-avatar-file" accept=".jpg,.jpeg,.png,image/jpeg,image/png" hidden>
              </div>
              <div class="vp-field vp-help-row"><span class="vp-label"></span><div class="vp-control vp-help">256 × 256 像素 · JPG / JPEG / PNG · 文件小于 50KB · 选一次后作为本浏览器所有账户的默认头像</div></div>
              <div class="vp-field">
                <label class="vp-label" for="vp-headline">广告标题 <em>*</em></label>
                <div class="vp-control"><input id="vp-headline" maxlength="15" placeholder="请输入广告标题"></div>
              </div>
              <div class="vp-field">
                <label class="vp-label" for="vp-link">DeepLink</label>
                <div class="vp-control"><input id="vp-link" placeholder="请输入 DeepLink"></div>
              </div>
              <div class="vp-field">
                <label class="vp-label" for="vp-exposure">曝光监测地址</label>
                <div class="vp-control"><input id="vp-exposure" placeholder="请输入曝光监测地址"></div>
              </div>
              <div class="vp-field">
                <label class="vp-label" for="vp-click">点击监测地址</label>
                <div class="vp-control"><input id="vp-click" placeholder="请输入点击监测地址"></div>
              </div>
              <div class="vp-field vp-help-row">
                <span class="vp-label"></span>
                <div class="vp-control vp-help">三个链接可全部留空；只要填写其中一个，就必须填写完整三个。点击「开始创建广告」时检查链接类型、partnerId、vivo 渠道及 taskId。</div>
              </div>
            </main>
            <footer class="vp-footer">
              <div id="vp-notice" role="status" aria-live="polite" hidden></div>
              <span class="vp-footnote" id="vp-plan-count">当前共 1 个计划 · 逐个提交并关闭，全部成功后刷新列表</span>
              <div class="vp-footer-actions"><button type="button" class="vp-button vp-outline" data-action="close">取消</button><button type="submit" class="vp-button vp-primary" id="vp-submit">开始批量创建（1）</button></div>
            </footer>
          </form>
        </section>
      </div>`;
  }

  function find(selector) {
    return shadow.querySelector(selector);
  }

  function showNotice(message, isError = false) {
    const notice = find("#vp-notice");
    if (!notice) return;
    notice.textContent = message;
    notice.className = isError ? "vp-notice is-error" : "vp-notice";
    notice.hidden = false;
  }

  function hideNotice() {
    const notice = find("#vp-notice");
    if (notice) notice.hidden = true;
  }

  function showOldTaskRecovery() {
    showNotice("上次创建任务仍占用此窗口。结束旧任务后，可以保留当前填写内容并重新开始。", true);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "vp-recover-task";
    button.textContent = "结束旧任务";
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const result = await chrome.runtime.sendMessage({type:"VPE_RECOVER_WINDOW"});
        if (!result?.ok) throw new Error(result?.error || "结束旧任务失败");
        showNotice("旧任务已结束，当前填写内容已保留。请重新点击「开始批量创建」。");
      } catch (error) {
        button.disabled = false;
        showNotice(`结束旧任务失败：${error.message}`, true);
      }
    });
    find("#vp-notice").appendChild(button);
  }

  function planById(id) {
    return state.plans.find(plan => plan.id === id);
  }

  function renderPlanCards() {
    find("#vp-plan-list").innerHTML = state.plans.map((plan, index) => {
      const id = escapeHtml(plan.id);
      const groups = TRAFFIC_GROUPS.map(group => {
        const selected = group.items.filter(item => plan.traffic.has(item)).length;
        return `<div class="vp-traffic-group">
          <label class="vp-check vp-parent"><input type="checkbox" data-group="${escapeHtml(group.name)}" ${selected === group.items.length ? "checked" : ""}><span>${escapeHtml(group.name)}</span></label>
          <div class="vp-traffic-children">${group.items.map(item =>
            `<label class="vp-check"><input type="checkbox" data-traffic="${escapeHtml(item)}" ${plan.traffic.has(item) ? "checked" : ""}><span>${escapeHtml(item)}</span></label>`).join("")}</div>
        </div>`;
      }).join("");
      const video = plan.mediaType.startsWith("视频");
      const mediaList = plan.media.map((file, fileIndex) =>
        `<span class="vp-media-item"><span class="vp-media-item-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span><button type="button" class="vp-media-remove" data-file-index="${fileIndex}" aria-label="移除素材 ${escapeHtml(file.name)}">×</button></span>`).join("");
      return `<section class="vp-plan-card" data-plan-id="${id}" aria-label="计划 ${index + 1}">
        <div class="vp-card-heading"><strong>计划 ${index + 1}</strong>
          <button type="button" class="vp-button vp-delete-plan" data-action="delete-plan" ${state.plans.length === 1 ? "disabled title='至少保留一个计划'" : ""}>▤ 删除计划</button>
        </div>
        <div class="vp-field"><label class="vp-label" for="vp-name-${id}">广告计划名称 <em>*</em></label><div class="vp-control"><input id="vp-name-${id}" data-plan-name type="text" maxlength="200" autocomplete="off" placeholder="请输入广告计划名称（200字以内）" value="${escapeHtml(plan.planName)}"></div></div>
        <div class="vp-rule"></div>
        <div class="vp-field vp-top"><span class="vp-label">流量选择 <em>*</em></span><div class="vp-control vp-traffic" role="group" aria-label="计划 ${index + 1} 的流量选择">${groups}</div></div>
        <div class="vp-rule"></div>
        <div class="vp-field"><span class="vp-label">素材类型 <em>*</em></span>
          <div class="vp-control vp-media-types" role="group" aria-label="计划 ${index + 1} 的素材类型">${MEDIA_TYPES.map(type =>
            `<button type="button" class="vp-button vp-type${plan.mediaType === type ? " is-selected" : ""}" data-media-type="${escapeHtml(type)}" aria-pressed="${plan.mediaType === type}">${plan.mediaType === type ? "✓" : "＋"} ${escapeHtml(type)}</button>`).join("")}</div>
        </div>
        <div class="vp-field"><span class="vp-label">本地素材 <em>*</em></span>
          <div class="vp-control"><input readonly class="vp-media-display" placeholder="尚未选择${video ? "视频" : "图片"}文件（最多5个）" aria-label="计划 ${index + 1} 已选择的本地素材" value="${escapeHtml(plan.media.map(file => file.name).join("、"))}"></div>
          <button type="button" class="vp-button vp-outline vp-file-button" data-action="choose-media">↥ 选择${video ? "视频" : "图片"}</button>
        </div>
        <div class="vp-field vp-help-row vp-media-summary-row" ${plan.media.length ? "" : "hidden"}><span class="vp-label"></span><div class="vp-control vp-media-summary"><span class="vp-media-count">已选 ${plan.media.length}/${MAX_MEDIA_FILES}</span><div class="vp-media-list">${mediaList}</div></div></div>
      </section>`;
    }).join("");
    find('[data-action="add-plan"]').disabled = state.plans.length >= MAX_PLANS;
    find("#vp-plan-count").textContent = `当前共 ${state.plans.length} 个计划 · 逐个提交并关闭，全部成功后刷新列表`;
    find("#vp-submit").textContent = `开始批量创建（${state.plans.length}）`;
    shadow.querySelectorAll(".vp-plan-card").forEach(card => {
      const plan = planById(card.dataset.planId);
      card.querySelectorAll("[data-group]").forEach(input => {
        const group = TRAFFIC_GROUPS.find(x => x.name === input.dataset.group);
        const count = group.items.filter(item => plan.traffic.has(item)).length;
        input.indeterminate = count > 0 && count < group.items.length;
      });
    });
  }

  function renderAppOptions() {
    const appSelect = find("#vp-app");
    const productSelect = find("#vp-product");
    const previousApp = appSelect.value;
    const previousProduct = productSelect.value;
    appSelect.replaceChildren(option("", "请选择应用"));
    [...new Set(state.associations.map(x => x.app))].forEach(a => appSelect.appendChild(option(a)));
    if ([...appSelect.options].some(o => o.value === previousApp)) appSelect.value = previousApp;

    productSelect.replaceChildren(option("", "请选择行业/产品"));
    state.associations.filter(x => x.app === appSelect.value).forEach(a => {
      productSelect.appendChild(option(a.id, `${a.industry} / ${a.product}`));
    });
    if ([...productSelect.options].some(o => o.value === previousProduct)) productSelect.value = previousProduct;
  }

  function renderPromoOptions() {
    const select = find("#vp-promo");
    const previous = select.value;
    select.replaceChildren(option("", "请选择推广名称"));
    state.promoNames.forEach(n => select.appendChild(option(n)));
    if (state.promoNames.includes(previous)) select.value = previous;
  }

  function applyDefaultSelections() {
    const association = state.associations.find(item => item.id === state.defaultAssociationId);
    if (association) {
      find("#vp-app").value = association.app;
      renderAppOptions();
      find("#vp-product").value = association.id;
    }
    if (state.defaultPromoName && state.promoNames.includes(state.defaultPromoName))
      find("#vp-promo").value = state.defaultPromoName;
  }

  function rowWithDelete(text, details, onDelete, isDefault, onDefault) {
    const row = document.createElement("div");
    row.className = "vp-list-item";
    const body = document.createElement("div");
    body.className = "vp-list-item-text";
    const title = document.createElement("div");
    title.className = "vp-item-name";
    title.textContent = text;
    body.appendChild(title);
    if (details) {
      const subtitle = document.createElement("div");
      subtitle.className = "vp-item-detail";
      subtitle.textContent = details;
      body.appendChild(subtitle);
    }
    const actions = document.createElement("div");
    actions.className = "vp-list-actions";
    const defaultButton = document.createElement("button");
    defaultButton.type = "button";
    defaultButton.className = `vp-button vp-default${isDefault ? " is-default" : ""}`;
    defaultButton.textContent = isDefault ? "✓ 默认" : "设为默认";
    defaultButton.setAttribute("aria-label", `${isDefault ? "取消" : "设为"}默认：${text}`);
    defaultButton.setAttribute("aria-pressed", String(isDefault));
    defaultButton.title = isDefault ? "点击取消默认" : "下次右键打开时自动选中";
    defaultButton.addEventListener("click", onDefault);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "vp-button vp-delete";
    button.textContent = "▤ 删除";
    button.setAttribute("aria-label", `删除 ${text}`);
    button.addEventListener("click", onDelete);
    actions.append(defaultButton, button);
    row.append(body, actions);
    return row;
  }

  function renderLists() {
    const appList = find("#vp-app-list");
    const nameList = find("#vp-name-list");
    appList.replaceChildren();
    nameList.replaceChildren();

    if (!state.associations.length) {
      const empty = document.createElement("div");
      empty.className = "vp-empty";
      empty.textContent = "暂无应用关联，请在下方添加。";
      appList.appendChild(empty);
    }
    state.associations.forEach(a => {
      appList.appendChild(rowWithDelete(a.app, `${a.industry} / ${a.product}`, () => {
        state.associations = state.associations.filter(x => x.id !== a.id);
        if (state.defaultAssociationId === a.id) state.defaultAssociationId = null;
        renderAppOptions();
        renderLists();
        void saveCatalog();
      }, state.defaultAssociationId === a.id, () => {
        state.defaultAssociationId = state.defaultAssociationId === a.id ? null : a.id;
        applyDefaultSelections();
        renderLists();
        void saveCatalog();
      }));
    });

    if (!state.promoNames.length) {
      const empty = document.createElement("div");
      empty.className = "vp-empty";
      empty.textContent = "暂无推广名称，请在下方添加。";
      nameList.appendChild(empty);
    }
    state.promoNames.forEach(name => {
      nameList.appendChild(rowWithDelete(name, "", () => {
        state.promoNames = state.promoNames.filter(x => x !== name);
        if (state.defaultPromoName === name) state.defaultPromoName = null;
        renderPromoOptions();
        renderLists();
        void saveCatalog();
      }, state.defaultPromoName === name, () => {
        state.defaultPromoName = state.defaultPromoName === name ? null : name;
        applyDefaultSelections();
        renderLists();
        void saveCatalog();
      }));
    });
  }

  function addAssociation() {
    const app = find("#vp-new-app").value.trim();
    const industry = find("#vp-new-industry").value.trim();
    const product = find("#vp-new-product").value.trim();
    if (!app || !industry || !product) return showNotice("请填写应用名称、行业和产品。", true);
    const existing = state.associations.find(a => a.app === app && a.industry === industry && a.product === product);
    if (existing) return showNotice("此应用关联已存在，可直接在下拉框选择。", true);

    const id = newId();
    state.associations.push({ id, app, industry, product });
    for (const selector of ["#vp-new-app", "#vp-new-industry", "#vp-new-product"]) find(selector).value = "";
    renderAppOptions();
    find("#vp-app").value = app;
    renderAppOptions();
    find("#vp-product").value = id;
    renderLists();
    hideNotice();
    void saveCatalog();
  }

  function addPromoName() {
    const input = find("#vp-new-name");
    const name = input.value.trim();
    if (!name) return showNotice("请填写推广名称。", true);
    if (state.promoNames.includes(name)) return showNotice("推广名称已存在，可直接选择。", true);
    state.promoNames.push(name);
    input.value = "";
    renderPromoOptions();
    find("#vp-promo").value = name;
    renderLists();
    hideNotice();
    void saveCatalog();
  }

  function toggleManager(kind) {
    const app = kind === "app";
    if (app) state.appManagerOpen = !state.appManagerOpen;
    else state.nameManagerOpen = !state.nameManagerOpen;
    const opened = app ? state.appManagerOpen : state.nameManagerOpen;
    find(app ? "#vp-app-manager" : "#vp-name-manager").hidden = !opened;
    find(app ? '[data-action="toggle-app-manager"]' : '[data-action="toggle-name-manager"]').setAttribute("aria-expanded", String(opened));
  }

  function selectMediaType(plan, type) {
    if (!plan || !MEDIA_TYPES.includes(type)) return;
    if (type !== plan.mediaType) {
      plan.mediaType = type;
      plan.media = [];
    }
    renderPlanCards();
  }

  async function imageDimensions(file) {
    const url = URL.createObjectURL(file);
    try {
      return await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
        image.onerror = () => reject(new Error("图片无法读取"));
        image.src = url;
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function videoDimensions(file) {
    const url = URL.createObjectURL(file);
    try {
      return await new Promise((resolve, reject) => {
        const video = document.createElement("video");
        let settled = false;
        const finish = (error, dimensions) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          video.removeAttribute("src");
          video.load();
          if (error) reject(error); else resolve(dimensions);
        };
        const timer = setTimeout(() => finish(new Error(`无法读取视频「${file.name}」的尺寸，请确认编码可在浏览器播放`)), 20000);
        video.preload = "metadata";
        video.onloadedmetadata = () => finish(null, { width: video.videoWidth, height: video.videoHeight });
        video.onerror = () => finish(new Error(`无法解析视频「${file.name}」，请使用浏览器支持的 MP4/MOV/WebM`));
        video.src = url;
        video.load();
      });
    } finally { URL.revokeObjectURL(url); }
  }

  async function handleAvatarFile(file) {
    if (!file) return;
    if (!(["image/jpeg", "image/png"].includes(file.type) || /\.(jpe?g|png)$/i.test(file.name))) {
      find("#vp-avatar-file").value = "";
      return showNotice("头像只支持 JPG、JPEG、PNG 图片。", true);
    }
    if (file.size >= 50 * 1024) {
      find("#vp-avatar-file").value = "";
      return showNotice("头像文件必须小于 50KB。", true);
    }
    try {
      const dimensions = await imageDimensions(file);
      if (dimensions.width !== 256 || dimensions.height !== 256) {
        find("#vp-avatar-file").value = "";
        return showNotice(`头像尺寸为 ${dimensions.width}×${dimensions.height}，请选 256×256 像素图片。`, true);
      }
    } catch {
      find("#vp-avatar-file").value = "";
      return showNotice("无法读取头像图片，请重新选择。", true);
    }
    state.avatar = file;
    try {
      state.avatarData = { name: file.name, dataUrl: await dataUrlFromFile(file) };
      await chrome.storage.local.set({ [AVATAR_KEY]: state.avatarData });
    } catch (error) {
      state.avatar = null;
      return showNotice(`头像本地保存失败：${error.message}`, true);
    }
    find("#vp-avatar-display").value = file.name;
    hideNotice();
  }

  async function chooseMediaHandles(plan) {
    if (!plan?.mediaType) return showNotice("请先选择此计划的素材类型。", true);
    // 必须直接由点击事件触发文件句柄选择器；普通 input[type=file] 只返回 File，
    // 无法跨标签页稳定保留文件句柄。不能悄悄退回 File/base64 存储。
    if (typeof window.showOpenFilePicker !== "function")
      return showNotice("当前浏览器不支持文件句柄选择器，请使用最新版 Chrome（HTTPS 页面），无法改用完整文件暂存。", true);
    const video = plan.mediaType.startsWith("视频");
    let handles;
    try {
      handles = await window.showOpenFilePicker({
        id: video ? "vivo-ad-video" : "vivo-ad-image", multiple: true,
        types: video ? [{ description: "MP4 / MOV / WebM 视频", accept: {
          "video/mp4": [".mp4"], "video/quicktime": [".mov"], "video/webm": [".webm"]
        } }] : [{ description: "JPG / PNG 图片", accept: {
          "image/jpeg": [".jpg", ".jpeg"], "image/png": [".png"]
        } }],
        excludeAcceptAllOption: true
      });
    } catch (error) {
      if (error?.name === "AbortError") return;
      return showNotice(`选择素材文件句柄失败：${error?.message || error}`, true);
    }
    if (!handles?.length) return;
    let files;
    try {
      files = await Promise.all(handles.map(async handle => {
        if (handle.kind !== "file" || typeof handle.getFile !== "function")
          throw new Error("所选项目没有有效文件句柄。");
        const file = await handle.getFile();
        return { handle, ...globalThis.VPMediaStore.metaOf(file) };
      }));
    } catch (error) {
      return showNotice(`读取所选文件信息失败：${error.message}`, true);
    }
    // 用户在系统文件选择器打开期间可能已移除计划或切换素材类型。
    if (!state.plans.includes(plan) || plan.mediaType.startsWith("视频") !== video)
      return showNotice("选择期间计划素材类型已变化，请重新选择文件。", true);
    const invalid = files.find(file => !(video ?
      (file.type.startsWith("video/") || /\.(mp4|mov|webm)$/i.test(file.name)) :
      (file.type.startsWith("image/") || /\.(jpe?g|png|webp)$/i.test(file.name))));
    if (invalid) {
      return showNotice(`请选择${video ? "视频" : "图片"}文件，与当前素材类型保持一致。`, true);
    }

    const existing = new Set(plan.media.map(file => `${file.name}\0${file.size}\0${file.lastModified}`));
    const added = [];
    for (const file of files) {
      const key = `${file.name}\0${file.size}\0${file.lastModified}`;
      if (!existing.has(key)) {
        existing.add(key);
        added.push(file);
      }
    }
    if (plan.media.length + added.length > MAX_MEDIA_FILES) {
      return showNotice(`每个计划最多选择 ${MAX_MEDIA_FILES} 个素材，当前已有 ${plan.media.length} 个，本次新增 ${added.length} 个。`, true);
    }
    plan.media.push(...added);
    renderPlanCards();
    hideNotice();
  }

  function validateForm() {
    if (!state.plans.length || state.plans.length > MAX_PLANS)
      return { message: "一次只能创建 1～10 个计划。" };
    // 新增计划会继承上一计划名称；真正开始批量创建前必须明确排除重名。
    // 放在其他必填项之前，让用户一点击开始就能看到重复名称的提示。
    const seenNames = new Map();
    for (const [index, plan] of state.plans.entries()) {
      const name = String(plan.planName || "").trim().replace(/\s+/g, " ").normalize("NFKC");
      if (!name) continue;
      if (seenNames.has(name)) {
        const first = seenNames.get(name) + 1;
        return {
          message: `计划 ${first} 和计划 ${index + 1} 的广告计划名称重复：「${name}」。请修改其中一个名称后再开始批量创建。`,
          selector: `[data-plan-id="${plan.id}"] [data-plan-name]`
        };
      }
      seenNames.set(name, index);
    }
    for (const [index, plan] of state.plans.entries()) {
      const position = `计划 ${index + 1}`;
      if (!plan.planName.trim()) return { message: `${position}：请输入广告计划名称。`, selector: `[data-plan-id="${plan.id}"] [data-plan-name]` };
      if (plan.traffic.size === 0) return { message: `${position}：请至少选择一个流量位置。` };
      if (!plan.mediaType) return { message: `${position}：请选择素材类型。` };
      if (plan.media.length < 1 || plan.media.length > MAX_MEDIA_FILES)
        return { message: `${position}：请选择 1～5 个基础素材文件。` };
    }
    const fields = [
      ["#vp-app", "请选择应用。"],
      ["#vp-product", "请选择行业/产品。"],
      ["#vp-promo", "请选择推广名称。"]
    ];
    for (const [selector, message] of fields.slice(0, 2))
      if (!find(selector).value) return { message, selector };
    const bid = Number(find("#vp-bid").value);
    if (!Number.isFinite(bid) || bid <= 0) return { message: "请输入大于 0 的出价金额。", selector: "#vp-bid" };
    if (!find("#vp-promo").value.trim()) return { message: fields[2][1], selector: "#vp-promo" };
    if (!state.avatarData) return { message: "请先选择 256×256 像素头像。", selector: '[data-action="choose-avatar"]' };
    const headline = find("#vp-headline").value.trim();
    if (headline.length < 6 || headline.length > 15)
      return { message: "广告标题需要 6～15 个字符。", selector: "#vp-headline" };
    const monitorLinks = {
      expose: find("#vp-exposure").value,
      click: find("#vp-click").value,
      deeplink: find("#vp-link").value
    };
    // 与旧 LoveExtension 一致：三项都空时跳过；任意一项非空时执行四项基础检测。
    // 这一步必须发生在 VPE_START 之前，不能先保存广告计划再发现链接错误。
    if (Object.values(monitorLinks).some(value => value.trim())) {
      if (typeof globalThis.VPLinkCheck?.validate !== "function")
        return { message: "监测链接检测组件未加载，请刷新扩展和当前网页后重试。" };
      const errors = globalThis.VPLinkCheck.validate(monitorLinks);
      if (errors.length) return { message: `监测链接基础检测未通过：\n${errors.join("\n")}` };
    }
    return null;
  }

  async function validateMedia(plan) {
    const video = plan.mediaType.startsWith("视频");
    const horizontal = plan.mediaType.endsWith("16:9");
    const names = new Set();
    for (const entry of plan.media) {
      const file = await globalThis.VPMediaStore.getCurrentFile(entry);
      if (video) {
        if (!/\.(mp4|mov|webm)$/i.test(file.name) || !file.type.startsWith("video/"))
          throw new Error(`「${file.name}」不是受支持的 MP4/MOV/WebM 视频。`);
      } else {
        if (!/\.(png|jpe?g)$/i.test(file.name) || !["image/png", "image/jpeg"].includes(file.type))
          throw new Error(`「${file.name}」不是 vivo 支持的 JPG/PNG 单图素材。`);
        if (file.size > 300 * 1024)
          throw new Error(`「${file.name}」超过 300KB，请压缩后重选。`);
      }
      if (file.size < 1) throw new Error(`「${file.name}」是空文件。`);
      const {width,height} = video ? await videoDimensions(file) : await imageDimensions(file);
      const valid = video ? (width > 0 && height > 0 &&
        Math.abs(width / height - (horizontal ? 16 / 9 : 9 / 16)) < 0.015) :
        (horizontal ? width * 9 === height * 16 && width >= 1280 && width <= 1920 :
          width * 16 === height * 9 && height >= 1280 && height <= 1920);
      if (!valid)
        throw new Error(`「${file.name}」尺寸 ${width}×${height} 与「${plan.mediaType}」不符。`);
      if (names.has(file.name)) throw new Error(`「${file.name}」文件名重复，无法唯一核验上传结果。`);
      names.add(file.name);
    }
  }

  async function onSubmit(event) {
    event.preventDefault();
    if (state.submitting) return;
    const error = validateForm();
    if (error) {
      showNotice(error.message, true);
      if (error.selector) find(error.selector)?.focus();
      return;
    }
    const association = state.associations.find(a => a.id === find("#vp-product").value);
    if (!association || !state.avatarData) return showNotice("请先选择应用关联并保存默认头像。", true);
    state.submitting = true;
    find("#vp-submit").disabled = true;
    find("#vp-form").classList.add("vp-busy");
    let batchId;
    try {
      await globalThis.VPMediaStore.pruneStale();
      for (const [index, plan] of state.plans.entries()) {
        showNotice(`正在检查计划 ${index + 1}/${state.plans.length} 的本地素材…`);
        await validateMedia(plan);
      }
      const payload = {
        plans: state.plans.map(plan => ({
          planName: plan.planName.trim(), traffic: [...plan.traffic],
          mediaType: plan.mediaType, fileCount: plan.media.length
        })),
        common: {
          appName: association.app, industry: association.industry,
          product: association.product,
          install: find('input[name="vp-install"]:checked').value,
          goal: find("#vp-goal").value,
          bid: find("#vp-bid").value.trim(),
          promoName: find("#vp-promo").value,
          headline: find("#vp-headline").value.trim(),
          deepLink: find("#vp-link").value,
          viewMonitorUrl: find("#vp-exposure").value,
          clickMonitorUrl: find("#vp-click").value,
          avatar: state.avatarData
        }
      };
      let response = await chrome.runtime.sendMessage({ type: "VPE_BATCH_PREPARE", payload });
      if (!response?.ok || !response.batchId) throw new Error(response?.error || "准备批量任务失败");
      batchId = response.batchId;
      for (const [planIndex, plan] of state.plans.entries()) {
        for (const [fileIndex, entry] of plan.media.entries()) {
          const video = plan.mediaType.startsWith("视频");
          showNotice(`正在准备计划 ${planIndex + 1}/${state.plans.length} 的第 ${fileIndex + 1}/${plan.media.length} 个${video ? "视频" : "图片"}…`);
          await globalThis.VPMediaStore.put(batchId, planIndex, fileIndex, entry);
          response = await chrome.runtime.sendMessage({
            type: "VPE_BATCH_MEDIA_REF", batchId, planIndex, fileIndex,
            meta: { name: entry.name, type: entry.type, size: entry.size, lastModified: entry.lastModified }
          });
          if (!response?.ok) throw new Error(response?.error || `计划 ${planIndex + 1} 素材写入失败`);
        }
      }
      response = await chrome.runtime.sendMessage({ type: "VPE_BATCH_START", batchId });
      if (!response?.ok || !response.run) throw new Error(response?.error || "启动批量任务失败");
      batchId = null;
      close(true);
      await window.VPWorkflow.start(response.run);
    } catch (error) {
      if (batchId) {
        try { await chrome.runtime.sendMessage({ type: "VPE_BATCH_CANCEL", batchId }); }
        catch (cleanupError) { console.warn("[VPE] 中止准备任务失败", cleanupError); }
        try { await globalThis.VPMediaStore.deleteBatch(batchId); }
        catch (cleanupError) { console.warn("[VPE] 中止准备任务后清理文件句柄失败", cleanupError); }
      }
      if (error.message.includes("此窗口已有未结束的创建任务")) showOldTaskRecovery();
      else showNotice(`自动执行未完成：${error.message}`, true);
      if (host.hidden) host.hidden = false;
    } finally {
      state.submitting = false;
      find("#vp-submit").disabled = false;
      find("#vp-form").classList.remove("vp-busy");
    }
  }

  function close(force = false) {
    if (!host) return;
    if (state.submitting && force !== true) return;
    host.hidden = true;
    document.documentElement.classList.remove("vp-dialog-open");
    previousFocus?.focus?.();
  }

  function resetDraft() {
    // 明确停止任务后，只清空本次创建表单；已保存的应用关联、推广名称、
    // 两处“设为默认”以及默认头像仍属于长期配置，不随任务删除。
    state.plans = [makePlan()];
    state.appManagerOpen = false;
    state.nameManagerOpen = false;
    state.submitting = false;
    if (!host) return;

    close(true);
    find("#vp-form").reset();
    for (const selector of ["#vp-app", "#vp-product", "#vp-promo",
      "#vp-headline", "#vp-link", "#vp-exposure", "#vp-click",
      "#vp-new-app", "#vp-new-industry", "#vp-new-product", "#vp-new-name"])
      find(selector).value = "";
    find("#vp-goal").value = "自定义拉活";
    find("#vp-bid").value = "0.1";
    const installed = find('input[name="vp-install"][value="已安装"]');
    if (installed) installed.checked = true;
    find("#vp-app-manager").hidden = true;
    find("#vp-name-manager").hidden = true;
    find('[data-action="toggle-app-manager"]').setAttribute("aria-expanded", "false");
    find('[data-action="toggle-name-manager"]').setAttribute("aria-expanded", "false");
    find("#vp-avatar-display").value = state.avatarData?.name || "";
    find("#vp-submit").disabled = false;
    find("#vp-form").classList.remove("vp-busy");
    renderPlanCards();
    renderAppOptions();
    renderPromoOptions();
    applyDefaultSelections();
    hideNotice();
  }

  function handleClick(event) {
    const typeButton = event.target.closest("[data-media-type]");
    if (typeButton) {
      selectMediaType(planById(typeButton.closest("[data-plan-id]")?.dataset.planId), typeButton.dataset.mediaType);
      return;
    }
    const removeButton = event.target.closest("[data-file-index]");
    if (removeButton) {
      const plan = planById(removeButton.closest("[data-plan-id]")?.dataset.planId);
      if (plan) {
        plan.media.splice(Number(removeButton.dataset.fileIndex), 1);
        renderPlanCards();
      }
      return;
    }
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (!action) return;
    switch (action) {
      case "close": close(); break;
      case "backdrop": if (event.target.classList.contains("vp-backdrop")) close(); break;
      case "add-plan": {
        if (state.plans.length >= MAX_PLANS) return showNotice("最多创建 10 个计划。", true);
        const plan = makePlan();
        plan.planName = state.plans.at(-1)?.planName || "";
        state.plans.push(plan);
        renderPlanCards();
        find(`[data-plan-id="${plan.id}"] [data-plan-name]`)?.focus();
        hideNotice();
        break;
      }
      case "delete-plan": {
        if (state.plans.length <= 1) return;
        const card = event.target.closest("[data-plan-id]");
        const index = state.plans.findIndex(plan => plan.id === card?.dataset.planId);
        if (index < 0) return;
        state.plans.splice(index, 1);
        renderPlanCards();
        hideNotice();
        break;
      }
      case "toggle-app-manager": toggleManager("app"); break;
      case "toggle-name-manager": toggleManager("name"); break;
      case "add-association": addAssociation(); break;
      case "add-name": addPromoName(); break;
      case "choose-avatar": find("#vp-avatar-file").click(); break;
      case "choose-media": {
        const card = event.target.closest("[data-plan-id]");
        const plan = planById(card?.dataset.planId);
        if (!plan?.mediaType) return showNotice("请先选择此计划的素材类型。", true);
        void chooseMediaHandles(plan);
        break;
      }
      default: break;
    }
  }

  function build() {
    if (!state.plans.length) state.plans = [makePlan()];
    host = document.createElement("div");
    host.id = "vivo-plan-assistant-root";
    host.hidden = true;
    shadow = host.attachShadow({ mode: "open" });
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = chrome.runtime.getURL("panel.css");
    shadow.appendChild(stylesheet);
    const shell = document.createElement("div");
    shell.innerHTML = template();
    shadow.appendChild(shell);
    document.documentElement.appendChild(host);

    shadow.addEventListener("click", handleClick);
    shadow.addEventListener("input", event => {
      if (event.target.matches("[data-plan-name]")) {
        const plan = planById(event.target.closest("[data-plan-id]")?.dataset.planId);
        if (plan) plan.planName = event.target.value;
      }
    });
    shadow.addEventListener("change", event => {
      const element = event.target;
      if (element.matches("[data-traffic]")) {
        const plan = planById(element.closest("[data-plan-id]")?.dataset.planId);
        if (!plan) return;
        if (element.checked) plan.traffic.add(element.dataset.traffic);
        else plan.traffic.delete(element.dataset.traffic);
        renderPlanCards();
      } else if (element.matches("[data-group]")) {
        const plan = planById(element.closest("[data-plan-id]")?.dataset.planId);
        const group = TRAFFIC_GROUPS.find(x => x.name === element.dataset.group);
        if (!plan || !group) return;
        group.items.forEach(item => element.checked ? plan.traffic.add(item) : plan.traffic.delete(item));
        renderPlanCards();
      } else if (element.id === "vp-app") {
        renderAppOptions();
      } else if (element.id === "vp-avatar-file") {
        void handleAvatarFile(element.files?.[0]);
      }
    });
    find("#vp-form").addEventListener("submit", onSubmit);
    document.addEventListener("keydown", event => {
      if (host?.hidden) return;
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    });
    renderPlanCards();
  }

  async function open() {
    await loadCatalog();
    if (!host) build();
    renderAppOptions();
    renderPromoOptions();
    applyDefaultSelections();
    renderLists();
    if (state.avatarData) find("#vp-avatar-display").value = state.avatarData.name;
    hideNotice();
    previousFocus = document.activeElement;
    host.hidden = false;
    find("[data-plan-name]")?.focus();
  }

  function onBlankAreaRightClick(event) {
    if (!/^\/marketing\/newpromotion\/plan\/?$/.test(location.pathname)) return;
    if (event.defaultPrevented || event.shiftKey) return;

    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    if (!target) return;

    // 网页按钮、输入控件、表格记录等仍保留正常右键菜单；只接管空白位置。
    const interactive = [
      "a", "button", "input", "select", "textarea", "label", "summary",
      "[contenteditable]", "[role='button']", "[role='link']", "[role='checkbox']",
      "[role='option']", "[role='listbox']", "[role='menu']", "[role='menuitem']",
      "table", "tr", "td", "th", "[role='row']", "[role='gridcell']",
      "#vivo-plan-assistant-root"
    ].join(",");
    if (target.closest(interactive)) return;

    const selection = window.getSelection();
    if (selection?.toString().trim() && selection.containsNode(target, true)) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    void open();
  }

  window.VPContent = { resetDraft };
  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === "VPE_CLEAN_BATCH_HANDLES" && message.batchId)
      void globalThis.VPMediaStore?.deleteBatch(message.batchId)
        .catch(error => console.warn("[VPE] 清理批量素材句柄失败", error));
    if (message?.type === "VPE_RESET_DRAFT") {
      if (message.batchId) void globalThis.VPMediaStore?.deleteBatch(message.batchId)
        .catch(error => console.warn("[VPE] 停止任务后清理素材句柄失败", error));
      resetDraft();
    }
  });
  document.addEventListener("contextmenu", onBlankAreaRightClick, true);
})();
