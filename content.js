(() => {
  "use strict";

  if (window.top !== window || window.__vivoPlanAssistantInstalled) return;
  window.__vivoPlanAssistantInstalled = true;

  const STORAGE_KEY = "vivoPlanAssistantCatalogV1";
  const TRAFFIC_GROUPS = [
    { name: "商店", items: ["推荐列表", "首页banner", "搜索推广"] },
    { name: "非商店", items: ["信息流"] },
    { name: "联盟", items: ["原生", "激励视频", "插屏", "开屏", "BANNER"] }
  ];
  const GOALS = ["下载", "新增激活", "自定义付费", "自定义激活", "自定义拉活", "自定义注册"];
  const MEDIA_TYPES = ["单图 16:9", "单图 9:16", "视频 16:9", "视频 9:16"];

  const state = {
    associations: [],
    promoNames: [],
    traffic: new Set(),
    mediaType: "单图 16:9",
    avatar: null,
    media: null,
    appManagerOpen: false,
    nameManagerOpen: false,
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
      }
    } catch (error) {
      console.warn("[vivo 广告计划助手] 加载本地选项失败", error);
    }
    state.loaded = true;
  }

  async function saveCatalog() {
    try {
      await chrome.storage.local.set({
        [STORAGE_KEY]: {
          associations: state.associations,
          promoNames: state.promoNames
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
    const groups = TRAFFIC_GROUPS.map(group => `
      <div class="vp-traffic-group">
        <label class="vp-check vp-parent"><input type="checkbox" data-group="${escapeHtml(group.name)}"><span>${escapeHtml(group.name)}</span></label>
        <div class="vp-traffic-children">
          ${group.items.map(item => `<label class="vp-check"><input type="checkbox" data-traffic="${escapeHtml(item)}"><span>${escapeHtml(item)}</span></label>`).join("")}
        </div>
      </div>
    `).join("");

    return `
      <div class="vp-backdrop" data-action="backdrop">
        <section class="vp-modal" role="dialog" aria-modal="true" aria-labelledby="vp-title" tabindex="-1">
          <header class="vp-header">
            <div class="vp-heading"><h1 id="vp-title">批量新建广告</h1><span class="vp-badge">单计划</span></div>
            <button type="button" class="vp-icon-button" data-action="close" aria-label="关闭弹窗">×</button>
          </header>
          <form id="vp-form" novalidate>
            <main class="vp-body">
              <div class="vp-field">
                <label class="vp-label" for="vp-plan">广告计划名称 <em>*</em></label>
                <div class="vp-control"><input id="vp-plan" type="text" maxlength="200" placeholder="请输入广告计划名称（200字以内）" autocomplete="off"></div>
              </div>

              <div class="vp-rule"></div>
              <div class="vp-field vp-top">
                <span class="vp-label">流量选择 <em>*</em></span>
                <div class="vp-control vp-traffic" role="group" aria-label="流量选择">${groups}</div>
              </div>

              <div class="vp-rule"></div>
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
                <label class="vp-label" for="vp-install">安装定向</label>
                <div class="vp-control vp-half"><select id="vp-install"><option>不限</option><option>未安装</option><option selected>已安装</option></select></div>
              </div>
              <div class="vp-two-column">
                <div class="vp-field">
                  <label class="vp-label" for="vp-goal">优化目标 <em>*</em></label>
                  <div class="vp-control"><select id="vp-goal">${GOALS.map(g => `<option${g === "自定义拉活" ? " selected" : ""}>${g}</option>`).join("")}</select></div>
                </div>
                <div class="vp-field vp-bid-field">
                  <label class="vp-label" for="vp-bid">出价金额 <em>*</em></label>
                  <div class="vp-control"><input id="vp-bid" type="number" min="0.01" step="0.01" inputmode="decimal" placeholder="请输入金额"></div>
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
              <div class="vp-field vp-help-row"><span class="vp-label"></span><div class="vp-control vp-help">256 × 256 像素 · JPG / JPEG / PNG · 文件小于 50KB</div></div>
              <div class="vp-field">
                <span class="vp-label">素材类型 <em>*</em></span>
                <div id="vp-media-types" class="vp-control vp-media-types" role="group" aria-label="素材类型">${MEDIA_TYPES.map(m => `<button type="button" class="vp-button vp-type${m === "单图 16:9" ? " is-selected" : ""}" data-media-type="${m}">${m === "单图 16:9" ? "✓" : "＋"} ${m}</button>`).join("")}</div>
              </div>
              <div class="vp-field">
                <span class="vp-label">本地素材 <em>*</em></span>
                <div class="vp-control"><input id="vp-media-display" readonly placeholder="尚未选择图片文件" aria-label="已选择的素材文件"></div>
                <button type="button" class="vp-button vp-outline vp-file-button" data-action="choose-media">↥ 选择图片</button>
                <input type="file" id="vp-media-file" accept="image/*" hidden>
              </div>
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
            </main>
            <footer class="vp-footer">
              <span class="vp-footnote">广告名称自动与广告计划名称保持一致</span>
              <div class="vp-footer-actions"><button type="button" class="vp-button vp-outline" data-action="close">取消</button><button type="submit" class="vp-button vp-primary">开始创建广告</button></div>
            </footer>
            <div id="vp-notice" role="status" aria-live="polite" hidden></div>
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

  function renderTraffic() {
    shadow.querySelectorAll("[data-traffic]").forEach(input => {
      input.checked = state.traffic.has(input.dataset.traffic);
    });
    shadow.querySelectorAll("[data-group]").forEach(input => {
      const group = TRAFFIC_GROUPS.find(x => x.name === input.dataset.group);
      const count = group.items.filter(x => state.traffic.has(x)).length;
      input.checked = count === group.items.length;
      input.indeterminate = count > 0 && count < group.items.length;
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

  function rowWithDelete(text, details, onDelete) {
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
    const button = document.createElement("button");
    button.type = "button";
    button.className = "vp-button vp-delete";
    button.textContent = "▤ 删除";
    button.setAttribute("aria-label", `删除 ${text}`);
    button.addEventListener("click", onDelete);
    row.append(body, button);
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
        renderAppOptions();
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
        renderPromoOptions();
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

  function selectMediaType(type) {
    if (!MEDIA_TYPES.includes(type)) return;
    const changed = type !== state.mediaType;
    state.mediaType = type;
    shadow.querySelectorAll("[data-media-type]").forEach(button => {
      const active = button.dataset.mediaType === type;
      button.classList.toggle("is-selected", active);
      button.textContent = `${active ? "✓" : "＋"} ${button.dataset.mediaType}`;
      button.setAttribute("aria-pressed", String(active));
    });
    const video = type.startsWith("视频");
    find("#vp-media-file").accept = video ? "video/*" : "image/*";
    find('[data-action="choose-media"]').textContent = video ? "↥ 选择视频" : "↥ 选择图片";
    find("#vp-media-display").placeholder = video ? "尚未选择视频文件" : "尚未选择图片文件";
    if (changed) {
      state.media = null;
      find("#vp-media-file").value = "";
      find("#vp-media-display").value = "";
    }
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
    find("#vp-avatar-display").value = file.name;
    hideNotice();
  }

  function handleMediaFile(file) {
    if (!file) return;
    const video = state.mediaType.startsWith("视频");
    const valid = video ? (file.type.startsWith("video/") || /\.(mp4|mov|webm)$/i.test(file.name)) :
      (file.type.startsWith("image/") || /\.(jpe?g|png|webp)$/i.test(file.name));
    if (!valid) {
      find("#vp-media-file").value = "";
      return showNotice(`请选择${video ? "视频" : "图片"}文件，与当前素材类型保持一致。`, true);
    }
    state.media = file;
    find("#vp-media-display").value = file.name;
    hideNotice();
  }

  function validateForm() {
    const fields = [
      ["#vp-plan", "请输入广告计划名称。"],
      ["#vp-app", "请选择应用。"],
      ["#vp-product", "请选择行业/产品。"],
      ["#vp-promo", "请选择推广名称。"],
      ["#vp-headline", "请输入广告标题。"]
    ];
    if (!find("#vp-plan").value.trim()) return { message: fields[0][1], selector: fields[0][0] };
    if (state.traffic.size === 0) return { message: "请至少选择一个流量位置。" };
    for (const [selector, message] of fields.slice(1, 3)) {
      if (!find(selector).value) return { message, selector };
    }
    const bid = Number(find("#vp-bid").value);
    if (!Number.isFinite(bid) || bid <= 0) return { message: "请输入大于 0 的出价金额。", selector: "#vp-bid" };
    for (const [selector, message] of fields.slice(3)) {
      if (!find(selector).value.trim()) return { message, selector };
    }
    if (!state.avatar) return { message: "请先选择 256×256 像素头像。", selector: '[data-action="choose-avatar"]' };
    if (!state.media) return { message: "请先选择本地素材文件。", selector: '[data-action="choose-media"]' };
    return null;
  }

  function onSubmit(event) {
    event.preventDefault();
    const error = validateForm();
    if (error) {
      showNotice(error.message, true);
      if (error.selector) find(error.selector)?.focus();
      return;
    }
    // Intentional: no network requests or writes to the vivo website in V0.1.
    // In the next phase, these values will be mapped onto the actual plan/ad forms.
    showNotice("配置校验通过。当前是界面版，尚未接入真实计划创建；不会向 vivo 提交数据。");
  }

  function close() {
    if (!host) return;
    host.hidden = true;
    document.documentElement.classList.remove("vp-dialog-open");
    previousFocus?.focus?.();
  }

  function handleClick(event) {
    const typeButton = event.target.closest("[data-media-type]");
    if (typeButton) {
      selectMediaType(typeButton.dataset.mediaType);
      return;
    }
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (!action) return;
    switch (action) {
      case "close": close(); break;
      case "backdrop": if (event.target.classList.contains("vp-backdrop")) close(); break;
      case "toggle-app-manager": toggleManager("app"); break;
      case "toggle-name-manager": toggleManager("name"); break;
      case "add-association": addAssociation(); break;
      case "add-name": addPromoName(); break;
      case "choose-avatar": find("#vp-avatar-file").click(); break;
      case "choose-media": find("#vp-media-file").click(); break;
      default: break;
    }
  }

  function build() {
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
    shadow.addEventListener("change", event => {
      const element = event.target;
      if (element.matches("[data-traffic]")) {
        if (element.checked) state.traffic.add(element.dataset.traffic);
        else state.traffic.delete(element.dataset.traffic);
        renderTraffic();
      } else if (element.matches("[data-group]")) {
        const group = TRAFFIC_GROUPS.find(x => x.name === element.dataset.group);
        group.items.forEach(item => element.checked ? state.traffic.add(item) : state.traffic.delete(item));
        renderTraffic();
      } else if (element.id === "vp-app") {
        renderAppOptions();
      } else if (element.id === "vp-avatar-file") {
        void handleAvatarFile(element.files?.[0]);
      } else if (element.id === "vp-media-file") {
        handleMediaFile(element.files?.[0]);
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
    renderTraffic();
    selectMediaType(state.mediaType);
  }

  async function open() {
    await loadCatalog();
    if (!host) build();
    renderAppOptions();
    renderPromoOptions();
    renderLists();
    hideNotice();
    previousFocus = document.activeElement;
    host.hidden = false;
    find("#vp-plan").focus();
  }

  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === "VIVO_PLAN_OPEN_FORM") void open();
  });
})();
