(() => {
  "use strict";

  // 素材库属于 vivo 的另一个域名，父页面无法直接访问它的 DOM。
  // 本脚本只处理嵌入在广告编辑页的素材库，不负责保存或发布广告。
  if (window.top === window || !location.pathname.startsWith("/material-center-new")) return;

  const clean = value => String(value || "").replace(/\s+/g, "").trim();
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  let busy = false;

  function visible(el) {
    if (!el?.isConnected) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  }

  function assetName(card) {
    const nested = card.querySelector(".file-name");
    if (nested && clean(nested.textContent)) return nested.textContent.trim();

    // vivo 的真实素材 DOM 中，图片 .material-item 与文件名 .file-name
    // 可以是兄弟节点。仅当外层容器恰好属于这一张卡片时才关联名称，
    // 不允许到整个网格中随意抓取另一张卡片的名字。
    let parent = card.parentElement;
    for (let depth = 0; depth < 3 && parent; depth++, parent = parent.parentElement) {
      if (parent.querySelectorAll(".material-item").length !== 1) break;
      const names = [...parent.querySelectorAll(".file-name")];
      if (names.length === 1 && clean(names[0].textContent))
        return names[0].textContent.trim();
    }
    return "";
  }

  function assetCard(name) {
    return [...document.querySelectorAll(".material-item")].find(card =>
      visible(card) && clean(assetName(card)) === clean(name)) || null;
  }

  function chooseCard(name) {
    const exact = assetCard(name);
    if (exact) return {card:exact,matchMode:"filename"};

    // 扩展里保存的本地文件名（例如「1.jpg」）可能与平台素材名称
    // （例如「蓝-品牌logo」）不同。只有后台明确显示「共1条」且
    // 当前没有文件名过滤条件时，才使用唯一素材；不能凭列表暂时只有
    // 一张卡片就认为素材库真的只有一个文件。
    const filenameFilter = [...document.querySelectorAll("input")]
      .find(input => (input.placeholder || "").includes("文件名"));
    if (filenameFilter?.value?.trim()) return null;
    const match = (document.body?.innerText || "").match(/共\s*(\d+)\s*条/);
    if (!match || Number(match[1]) !== 1) return null;
    const cards = [...document.querySelectorAll(".material-item")].filter(visible);
    return cards.length === 1 ? {card:cards[0],matchMode:"only-item"} : null;
  }

  function isSelected(card) {
    return !!(card?.querySelector(".check.is-check,label.el-checkbox.is-checked,input[type='checkbox']:checked"));
  }

  async function waitFor(check, timeout, description) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const result = check();
      if (result) return result;
      await delay(150);
    }
    throw new Error(`素材库中${description}，已停止，不会假报成功。`);
  }

  async function selectAvatar(name) {
    if (busy) throw new Error("素材库正在处理另一个选中操作。");
    busy = true;
    try {
      let choice;
      try {
        choice = await waitFor(() => chooseCard(name), 6000,
          `没有找到「${name}」素材卡片，且无法安全确认素材库只有一条素材`);
      } catch (error) {
        // 找不到卡片是可识别的业务状态；由父页面切换「本地上传」。
        // 勾选失败等其他错误仍向上抛出，不能误走回退流程。
        if (error.message.startsWith(`素材库中没有找到「${name}」素材卡片`))
          return {selected:false,notFound:true};
        throw error;
      }
      const {card,matchMode} = choice;
      const selectedName = assetName(card);
      if (!selectedName) throw new Error("素材卡片缺少文件名称，无法确认选中对象。");
      if (!isSelected(card)) {
        // 用户截图确认选中的状态为 .check.is-check / label.el-checkbox.is-checked。
        // 素材卡片本体可能打开图片预览；点击真正的 Element 复选框标签。
        const checkbox = card.querySelector("label.el-checkbox");
        if (!checkbox || !visible(checkbox)) {
          throw new Error(`「${selectedName}」素材卡片没有可见的复选框，已停止。`);
        }
        checkbox.click();
        await waitFor(() => isSelected(card), 4000, `未检测到「${selectedName}」的勾选状态`);
      }
      const drawer = [...document.querySelectorAll(".el-drawer")].find(visible);
      if (drawer && /已选择\s*0\s*\/\s*1/.test(drawer.textContent || "")) {
        throw new Error("素材卡片已勾选，但素材库仍显示「已选择0/1」。");
      }
      return {selected:true,name:selectedName,matchMode};
    } finally {
      busy = false;
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type !== "VPE_MATERIAL_ACTION") return;
    if (message.action === "select") {
      if (typeof message.name !== "string" || !message.name.trim() || message.name.length > 120) {
        respond({ok:false,error:"头像素材名称无效。"});
        return false;
      }
      void selectAvatar(message.name)
        .then(result => respond({ok:true,...result}))
        .catch(error => respond({ok:false,error:error.message}));
      return true;
    }
    respond({ok:false,error:"未知素材操作。"});
    return false;
  });
})();
