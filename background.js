const MENU_ID = "vivo-batch-create-one-plan";
const PLAN_URL = /^https:\/\/ad\.vivo\.com\.cn\/marketing\/newpromotion\/plan(?:[/?#]|$)/;

function createMenu() {
  chrome.contextMenus.remove(MENU_ID, () => {
    // remove may fail on a fresh installation; create still proceeds.
    void chrome.runtime.lastError;
    chrome.contextMenus.create({
      id: MENU_ID,
      title: "批量新建广告",
      contexts: ["page"],
      documentUrlPatterns: ["https://ad.vivo.com.cn/marketing/newpromotion/plan*"]
    });
  });
}

chrome.runtime.onInstalled.addListener(createMenu);
chrome.runtime.onStartup.addListener(createMenu);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id || !PLAN_URL.test(info.pageUrl || tab.url || "")) return;
  chrome.tabs.sendMessage(tab.id, { type: "VIVO_PLAN_OPEN_FORM" }, () => {
    // When a page is still loading the content script may not yet exist.
    // The user can retry after the page finishes loading.
    void chrome.runtime.lastError;
  });
});
