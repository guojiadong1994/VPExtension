const RUN_KEY = "vivoPlanAssistantActiveRunsV1";
const BATCH_KEY = "vivoPlanAssistantBatchesV1";
const RESULT_KEY = "vivoPlanAssistantBatchResultsV1";
const RUN_TTL = 4 * 60 * 60 * 1000;
const TAB_OPEN_TIMEOUT = 30 * 1000;
const PLAN_LIST_URL = "https://ad.vivo.com.cn/marketing/newpromotion/plan";
const NEW_PLAN_URL = "https://ad.vivo.com.cn/marketing/newads/add";
let mutationChain = Promise.resolve();

// 背景服务线程只保存元数据；所有本地素材文件句柄由 vivo 同源页 IndexedDB 持有。
// 从旧版本遗留的图片 base64 数据库不再参与任何任务，首次运行时尽力清理。
try {
  indexedDB?.deleteDatabase?.("vivoPlanAssistantBatchMediaV1");
} catch { /* 老环境可能没有此数据库 */ }

async function cleanBatchHandles(sourceTabId, batchId) {
  if (!Number.isInteger(sourceTabId) || !batchId) return;
  try { await chrome.tabs.sendMessage(sourceTabId, { type: "VPE_CLEAN_BATCH_HANDLES", batchId }); }
  catch { /* 来源页已关闭时由句柄库 TTL 清理 */ }
}

function planPayload(batch, index) {
  const plan = batch.plans[index];
  return {
    ...batch.common,
    planName: plan.planName,
    adName: plan.planName,
    traffic: plan.traffic,
    mediaType: plan.mediaType,
    mediaCount: plan.fileCount,
    mediaMeta: plan.mediaMeta || []
  };
}

function batchRun(batch, index, tabId) {
  return {
    id: crypto.randomUUID(), createdAt: Date.now(), stage: "plan",
    windowId: batch.windowId, sourceTabId: batch.sourceTabId,
    batchId: batch.id, batchIndex: index, batchTotal: batch.plans.length,
    payload: planPayload(batch, index)
  };
}

function serialized(action) {
  const task = mutationChain.then(action, action);
  mutationChain = task.catch(() => {});
  return task;
}

function newPlanUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin === "https://ad.vivo.com.cn" &&
      parsed.pathname === "/marketing/newads/add";
  } catch {
    return false;
  }
}

function vivoPage(url, pathname) {
  try {
    const parsed = new URL(url);
    return parsed.origin === "https://ad.vivo.com.cn" && parsed.pathname === pathname;
  } catch { return false; }
}

async function returnToPlanAfterSubmit(tabId, url) {
  if (!vivoPage(url, "/marketing/newpromotion/advertisement")) return;
  const runs = await activeRuns();
  const key = String(tabId);
  const run = runs[key];
  // 人工修正最终提交错误后，用户可能直接在网页上再次提交。
  // 即使任务仍处于暂停状态，只要真正跳到广告列表就按成功完成收尾。
  if (!run || !["submitting-ad", "paused-ad-submit"].includes(run.stage)) return;

  // 只在当前任务点击“提交并关闭”后、浏览器确实跳到广告列表时才收尾。
  const tabs = await chrome.tabs.query({ windowId: run.windowId });
  const candidates = tabs.filter(tab => tab.id !== tabId && vivoPage(tab.url, "/marketing/newpromotion/plan"));
  const source = candidates.find(tab => tab.id === run.sourceTabId) ||
    (candidates.length === 1 ? candidates[0] : null);

  if (run.batchId) {
    const batches = (await chrome.storage.session.get(BATCH_KEY))[BATCH_KEY] || {};
    const batch = batches[run.batchId];
    if (!batch || batch.status !== "running" || batch.currentIndex !== run.batchIndex)
      throw new Error("批量执行进度与当前广告不一致，已停止自动续建。 ");
    const nextIndex = run.batchIndex + 1;
    const destination = source?.id ?? tabId;
    delete runs[key];
    batch.completed = nextIndex;
    if (nextIndex < batch.plans.length) {
      batch.currentIndex = nextIndex;
      if (!source) batch.sourceTabId = destination;
      runs[String(destination)] = batchRun(batch, nextIndex, destination);
    } else {
      batch.status = "completed";
      const results = (await chrome.storage.session.get(RESULT_KEY))[RESULT_KEY] || {};
      results[String(destination)] = {
        status: "completed", total: batch.plans.length, completed: nextIndex,
        names: batch.plans.map(plan => plan.planName), batchId: batch.id, at: Date.now()
      };
      await chrome.storage.session.set({ [RESULT_KEY]: results });
      delete batches[run.batchId];
    }
    await chrome.storage.session.set({ [RUN_KEY]: runs, [BATCH_KEY]: batches });
    if (source) {
      await chrome.tabs.update(source.id, { active: true });
      if (nextIndex === batch.plans.length) await chrome.tabs.reload(source.id);
      await chrome.tabs.remove(tabId);
      if (nextIndex < batch.plans.length) {
        // 中间计划不再刷新列表页，直接把下一条任务交给常驻的 content script。
        // 最后一条成功后才统一刷新，避免每次重新加载时提前查找按钮。
        // 恢复源标签页的焦点有一个短暂过渡期；按钮的坐标和遮挡判定
        // 必须在源标签页重新成为活动标签后进行。无论首条还是续建，
        // 最终都交给同一个 workflow.planStage 入口。
        await GOAL_PAUSE(400);
        try { await chrome.tabs.sendMessage(source.id, { type: "VPE_RESUME" }); }
        catch (error) { console.warn("[VPE] 续建提示未送达，任务仍保留等待恢复：", error); }
      }
    } else {
      await chrome.tabs.update(tabId, { active: true, url: PLAN_LIST_URL });
    }
    if (nextIndex === batch.plans.length && source) await cleanBatchHandles(source.id, batch.id);
    console.info(`[VPE] 批量任务已完成 ${nextIndex}/${batch.plans.length}，${nextIndex < batch.plans.length ? "继续下一个计划" : "全部结束"}。`);
    return;
  }

  if (source) {
    // 先激活并刷新原来的计划列表，再关闭新建广告产生的标签页。
    await chrome.tabs.update(source.id, { active: true });
    await chrome.tabs.reload(source.id);
    delete runs[key];
    await chrome.storage.session.set({ [RUN_KEY]: runs });
    await chrome.tabs.remove(tabId);
  } else {
    // 不存在唯一的原计划列表时，不猜测该关闭哪个页面：当前标签转到计划列表。
    await chrome.tabs.update(tabId, { active: true, url: PLAN_LIST_URL });
    delete runs[key];
    await chrome.storage.session.set({ [RUN_KEY]: runs });
  }
  console.info("[VPE] 广告已跳转到列表；已返回并刷新广告计划列表。");
}

function removeOldMenu() {
  // 从 V0.2.1 开始直接监听网页右键，移除旧的浏览器二级菜单入口。
  chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError;
  });
}

chrome.runtime.onInstalled.addListener(removeOldMenu);
chrome.runtime.onStartup.addListener(removeOldMenu);
removeOldMenu();

async function activeRuns() {
  const data = await chrome.storage.session.get(RUN_KEY);
  const runs = data[RUN_KEY] || {};
  for (const [id, run] of Object.entries(runs)) {
    if (!run || Date.now() - run.createdAt > RUN_TTL) delete runs[id];
  }
  return runs;
}

function validateBatchDraft(payload) {
  if (!payload || !Array.isArray(payload.plans) || payload.plans.length < 1 || payload.plans.length > 10)
    throw new Error("一次只能创建 1～10 个计划。");
  const common = payload.common;
  if (!common || !common.appName || !common.industry || !common.product || !common.promoName ||
      !common.goal || !common.headline || !common.avatar?.dataUrl)
    throw new Error("公共参数不完整，无法准备批量任务。");
  const seenNames = new Map();
  for (const [index, plan] of payload.plans.entries()) {
    if (!plan || !String(plan.planName || "").trim() || !Array.isArray(plan.traffic) || !plan.traffic.length ||
        !["单图 16:9", "单图 9:16", "视频 16:9", "视频 9:16"].includes(plan.mediaType) ||
        !Number.isInteger(plan.fileCount) || plan.fileCount < 1 || plan.fileCount > 5)
      throw new Error(`计划 ${index + 1} 的独立配置不完整。`);
    const name = String(plan.planName).trim().replace(/\s+/g, " ").normalize("NFKC");
    if (seenNames.has(name))
      throw new Error(`计划 ${seenNames.get(name) + 1} 和计划 ${index + 1} 的广告计划名称重复：「${name}」。请修改后重试。`);
    seenNames.set(name, index);
  }
}

async function transferToNewTab(tabId, tab) {
  const runs = await activeRuns();
  const destKey = String(tabId);
  if (runs[destKey]) return runs[destKey];

  // 兼容旧任务的网页打开模式。新任务由 VPE_OPEN_PLAN_TAB 在后台调用
  // chrome.tabs.create，并直接绑定返回的标签 ID，不再依赖网页弹窗。
  const candidates = Object.entries(runs).filter(([key, run]) =>
    key !== destKey && run.stage === "opening-plan-tab" && !run.openingDirectly &&
    Date.now() - run.openingAt >= 0 && Date.now() - run.openingAt < TAB_OPEN_TIMEOUT &&
    (typeof tab.windowId !== "number" || run.windowId === tab.windowId));
  const openerKey = typeof tab.openerTabId === "number" ? String(tab.openerTabId) : null;
  const match = candidates.find(([key]) => key === openerKey) ||
    (openerKey == null && candidates.length === 1 ? candidates[0] : null);
  if (!match) return null;

  const [sourceKey, run] = match;
  const transferred = { ...run, stage: "plan", sourceTabId: Number(sourceKey) };
  delete runs[sourceKey];
  runs[destKey] = transferred;
  await chrome.storage.session.set({ [RUN_KEY]: runs });
  return transferred;
}

// 旧版 LoveExtension 已证实：vivo 的优化目标下拉框可能不响应非可信的
// HTMLElement.click()。这里仅在绑定的新建计划标签页，使用 Chrome 的真实鼠标事件。
const GOAL_PAUSE = ms => new Promise(resolve => setTimeout(resolve, ms));

async function selectNativeGoal(tabId, desired, action, point) {
  const tab = await chrome.tabs.get(tabId);
  if (!newPlanUrl(tab?.url)) throw new Error("优化目标的浏览器级点击仅允许在 vivo 新建计划页面执行。");
  if (!["open", "choose"].includes(action) || !point ||
      !Number.isInteger(point.x) || !Number.isInteger(point.y) ||
      point.x < 0 || point.y < 0 ||
      (Number.isInteger(tab.width) && point.x >= tab.width) ||
      (Number.isInteger(tab.height) && point.y >= tab.height))
    throw new Error("优化目标的鼠标坐标无效，已停止。");
  const target = { tabId };
  let attached = false;
  let attachedAt = 0;
  async function clickAt(point) {
    const {x,y} = point;
    for (const [type, button, buttons] of [
      ["mousePressed", "left", 1], ["mouseReleased", "left", 0]
    ]) {
      await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
        type, x, y, button, buttons, clickCount: 1
      });
    }
  }

  try {
    try {
      await chrome.debugger.attach(target, "1.3");
      attached = true;
      attachedAt = Date.now();
    } catch (error) {
      throw new Error("无法启用优化目标的浏览器级点击。请关闭新建计划页的 F12 开发者工具，并确认允许扩展使用调试权限。" +
        `（${error?.message || error}）`);
    }
    // 坐标已由 content script 的普通 DOM 计算并检查遮挡；
    // Chrome 调试连接只负责发送三次原生鼠标事件，不再做 DOM 查询或等待动画。
    await clickAt(point);
    return {clicked:true,selected:desired,action,mode:"browser-native"};
  } finally {
    if (attached) {
      // 只为优化目标临时接入：选中后（或任何异常时）立即释放。
      // 旧版只打印 detach 错误，可能让 Chrome 顶部“正在调试”提示一直存在。
      let releaseError;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await chrome.debugger.detach(target);
          releaseError = null;
          break;
        } catch (error) {
          releaseError = error;
          // 用户可能已点提示条的“取消”，这种情况调试连接其实已经关闭。
          try {
            const targets = await chrome.debugger.getTargets?.();
            const current = targets?.find(item => item.tabId === tabId);
            if (current && !current.attached) { releaseError = null; break; }
          } catch { /* 下一轮继续尝试主动释放 */ }
          if (attempt < 2) await GOAL_PAUSE(120);
        }
      }
      if (releaseError) throw new Error(
        "优化目标操作结束，但浏览器调试连接未能自动关闭。请点击 Chrome 顶部提示条的「取消」，然后再继续。"
      );
      console.info(`[VPE] 优化目标「${action}」调试连接已断开，保持时间 ${Date.now() - attachedAt}ms`);
    }
  }
}

function materialFrames(frames) {
  return (frames || []).filter(frame => {
    try {
      const url = new URL(frame.url);
      return frame.frameId > 0 && url.origin === "https://adcc.vivo.com.cn" &&
        url.pathname.startsWith("/material-center-new");
    } catch { return false; }
  });
}

async function runMaterialAction(tabId, name) {
  const tab = await chrome.tabs.get(tabId);
  if (!newPlanUrl(tab?.url)) throw new Error("素材操作只能在当前 vivo 新建广告页面执行。");
  let connectionError;
  for (let attempt = 0; attempt < 16; attempt++) {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    const matches = materialFrames(frames);
    if (matches.length > 1) throw new Error("检测到多个素材库页面，无法确定当前操作对象。");
    if (matches.length === 1) {
      try {
        const result = await chrome.tabs.sendMessage(tabId,
          { type: "VPE_MATERIAL_ACTION", action: "select", name }, { frameId: matches[0].frameId });
        if (result?.ok === false) throw new Error(result.error || "素材库操作失败。");
        if (!result?.ok) throw new Error("素材库没有返回有效的操作结果。");
        return result;
      } catch (error) {
        // 扩展脚本可能稍晚于 iframe 的导航完成才被注入。仅重试连接失败，
        // 不重试已返回失败结果的点击，以免重复勾选。
        if (!/Receiving end does not exist|Could not establish connection/i.test(error.message))
          throw error;
        connectionError = error;
      }
    }
    await GOAL_PAUSE(350);
  }
  throw new Error(`无法连接头像素材库的独立页面，请确认其已经打开。${connectionError?.message || ""}`);
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  const url = info.url || tab.url || tab.pendingUrl;
  if (vivoPage(url, "/marketing/newpromotion/advertisement")) {
    return serialized(() => returnToPlanAfterSubmit(tabId, url))
      .catch(error => console.warn("[VPE] 提交后返回计划列表失败：", error));
  }
  if (vivoPage(url, "/marketing/newpromotion/plan") && info.status === "complete") {
    return serialized(async () => {
      const run = (await activeRuns())[String(tabId)];
      if (run?.stage === "plan") {
        try { await chrome.tabs.sendMessage(tabId, { type: "VPE_RESUME" }); }
        catch { /* content.js 在页面重载后也会主动恢复 */ }
      }
    });
  }
  if (!newPlanUrl(url)) return;
  return serialized(() => transferToNewTab(tabId, tab)).then(run => {
    if (run && info.status === "complete") {
      // 页面 content script 有可能先于任务转移初始化，因此主动唤醒一次。
      return Promise.resolve(chrome.tabs.sendMessage(tabId, { type: "VPE_RESUME" })).catch(() => {});
    }
  }).catch(error => console.warn("[VPE] 新标签页任务交接失败：", error));
});

// vivo 页面有可能通过前端路由 pushState 跳转，兜底监听主框架的 History API。
chrome.webNavigation?.onHistoryStateUpdated?.addListener(details => {
  if (details.frameId !== 0 || !vivoPage(details.url, "/marketing/newpromotion/advertisement")) return;
  void serialized(() => returnToPlanAfterSubmit(details.tabId, details.url))
    .catch(error => console.warn("[VPE] 前端路由返回计划列表失败：", error));
});

chrome.tabs.onRemoved?.addListener(tabId => {
  // 用户在准备文件期间直接关闭来源标签页，清理尚未启动的暂存任务。
  // 正在执行的批量任务不在这里取消，仍允许按既有逻辑回到计划列表。
  void serialized(async () => {
    const runs = await activeRuns();
    const interrupted = runs[String(tabId)];
    if (interrupted) {
      delete runs[String(tabId)];
      await chrome.storage.session.set({ [RUN_KEY]: runs });
      if (interrupted.batchId) {
        const batches = (await chrome.storage.session.get(BATCH_KEY))[BATCH_KEY] || {};
        const batch = batches[interrupted.batchId];
        if (batch) {
          const results = (await chrome.storage.session.get(RESULT_KEY))[RESULT_KEY] || {};
          results[String(batch.sourceTabId)] = {
            status: "failed", completed: batch.completed, total: batch.plans.length,
            failedIndex: interrupted.batchIndex, error: "执行标签页已关闭，任务安全停止。",
            names: batch.plans.map(plan => plan.planName), batchId: batch.id, at: Date.now()
          };
          delete batches[batch.id];
          await chrome.storage.session.set({ [BATCH_KEY]: batches, [RESULT_KEY]: results });
          await cleanBatchHandles(batch.sourceTabId, batch.id);
          if (batch.sourceTabId !== tabId) {
            try { await chrome.tabs.sendMessage(batch.sourceTabId, { type: "VPE_RESUME" }); }
            catch { /* 来源页未加载时可在刷新后看到结果 */ }
          }
        }
      }
    }
    const batches = (await chrome.storage.session.get(BATCH_KEY))[BATCH_KEY] || {};
    const abandoned = Object.values(batches).filter(batch =>
      batch.sourceTabId === tabId && batch.status === "preparing");
    if (!abandoned.length) return;
    for (const batch of abandoned) delete batches[batch.id];
    await chrome.storage.session.set({ [BATCH_KEY]: batches });
    for (const batch of abandoned) await cleanBatchHandles(batch.sourceTabId, batch.id);
  }).catch(error => console.warn("[VPE] 清理中断的批量准备任务失败", error));
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!message?.type?.startsWith("VPE_")) return;
  serialized(async () => {
    const tabId = sender.tab?.id;
    if (typeof tabId !== "number") throw new Error("只能从 vivo 页面启动自动执行。");
    const runs = await activeRuns();
    const key = String(tabId);

    switch (message.type) {
      case "VPE_BATCH_PREPARE": {
        if (sender.tab.url && !vivoPage(sender.tab.url, "/marketing/newpromotion/plan"))
          throw new Error("批量任务只能从广告计划列表页创建。");
        validateBatchDraft(message.payload);
        const batches = (await chrome.storage.session.get(BATCH_KEY))[BATCH_KEY] || {};
        for (const batch of Object.values(batches)) {
          if (Date.now() - batch.createdAt > RUN_TTL &&
              !Object.values(runs).some(run => run.batchId === batch.id)) {
            delete batches[batch.id];
            await cleanBatchHandles(batch.sourceTabId, batch.id);
          }
        }
        const busy = Object.values(runs).some(run => run.windowId === sender.tab.windowId) ||
          Object.values(batches).some(batch => batch.windowId === sender.tab.windowId);
        if (busy) throw new Error("此窗口已有未结束的创建任务，请先处理完成后再开始。");
        const batch = {
          id: crypto.randomUUID(), createdAt: Date.now(),
          sourceTabId: tabId, windowId: sender.tab.windowId,
          status: "preparing", currentIndex: 0, completed: 0,
          plans: message.payload.plans.map(p => ({
            planName: p.planName.trim(), traffic: [...p.traffic],
            mediaType: p.mediaType, fileCount: p.fileCount, mediaMeta: []
          })),
          common: message.payload.common,
          staged: message.payload.plans.map(() => [])
        };
        batches[batch.id] = batch;
        await chrome.storage.session.set({ [BATCH_KEY]: batches });
        return { batchId: batch.id };
      }
      case "VPE_BATCH_MEDIA":
      case "VPE_BATCH_GET_MEDIA":
        throw new Error("已禁用完整素材传输；图片和视频都必须通过页面文件句柄库读取。");
      case "VPE_BATCH_MEDIA_REF": {
        const batches = (await chrome.storage.session.get(BATCH_KEY))[BATCH_KEY] || {};
        const batch = batches[message.batchId];
        if (!batch || batch.sourceTabId !== tabId || batch.status !== "preparing")
          throw new Error("素材句柄登记请求与当前批量任务不一致。");
        const { planIndex, fileIndex, meta } = message;
        const type = batch.plans[planIndex]?.mediaType || "";
        const video = type.startsWith("视频");
        if (!Number.isInteger(planIndex) || planIndex < 0 || planIndex >= batch.plans.length ||
            !Number.isInteger(fileIndex) || fileIndex < 0 || fileIndex >= batch.plans[planIndex].fileCount ||
            !meta || !(video ? /\.(mp4|mov|webm)$/i : /\.(png|jpe?g)$/i).test(meta.name || "") ||
            !(video ? typeof meta.type === "string" && meta.type.startsWith("video/") :
              ["image/png", "image/jpeg"].includes(meta.type)) ||
            !Number.isSafeInteger(meta.size) || meta.size <= 0 ||
            (!video && meta.size > 300 * 1024) ||
            !Number.isSafeInteger(meta.lastModified) || meta.lastModified < 0)
          throw new Error("文件句柄对应的图片/视频元数据不合法，无法继续批量执行。");
        batch.plans[planIndex].mediaMeta[fileIndex] = {
          name: meta.name, type: meta.type, size: meta.size, lastModified: meta.lastModified
        };
        if (!batch.staged[planIndex].includes(fileIndex)) batch.staged[planIndex].push(fileIndex);
        await chrome.storage.session.set({ [BATCH_KEY]: batches });
        return { saved: true };
      }
      case "VPE_BATCH_START": {
        const batches = (await chrome.storage.session.get(BATCH_KEY))[BATCH_KEY] || {};
        const batch = batches[message.batchId];
        if (!batch || batch.sourceTabId !== tabId || batch.status !== "preparing" || runs[key])
          throw new Error("批量任务不能重复启动。");
        if (batch.plans.some((plan, index) => batch.staged[index].length !== plan.fileCount))
          throw new Error("仍有本地素材未写入，不能开始创建广告。");
        const run = batchRun(batch, 0, tabId);
        batch.status = "running";
        runs[key] = run;
        await chrome.storage.session.set({ [RUN_KEY]: runs, [BATCH_KEY]: batches });
        return { run };
      }
      case "VPE_BATCH_CANCEL": {
        const batches = (await chrome.storage.session.get(BATCH_KEY))[BATCH_KEY] || {};
        const batch = batches[message.batchId];
        if (!batch || batch.sourceTabId !== tabId || batch.status !== "preparing")
          return { cancelled: false };
        delete batches[batch.id];
        await chrome.storage.session.set({ [BATCH_KEY]: batches });
        await cleanBatchHandles(batch.sourceTabId, batch.id);
        return { cancelled: true };
      }
      case "VPE_BATCH_RESULT": {
        const results = (await chrome.storage.session.get(RESULT_KEY))[RESULT_KEY] || {};
        const result = results[key] || null;
        if (result) {
          delete results[key];
          await chrome.storage.session.set({ [RESULT_KEY]: results });
        }
        return { result };
      }
      case "VPE_START": {
        if (runs[key]) throw new Error("此标签页已有执行中的任务。请先结束或刷新后重试。");
        const run = {
          id: crypto.randomUUID(),
          createdAt: Date.now(),
          stage: "plan",
          windowId: sender.tab.windowId,
          payload: message.payload
        };
        runs[key] = run;
        await chrome.storage.session.set({ [RUN_KEY]: runs });
        return { run };
      }
      case "VPE_GET_RUN":
        return { run: runs[key] || null };
      case "VPE_PLAN_TAB_STATUS": {
        const moved = Object.entries(runs).filter(([destination, run]) =>
          destination !== key && run.id === message.id && run.stage !== "opening-plan-tab" &&
          run.sourceTabId === tabId);
        if (moved.length > 1) throw new Error("新建计划标签页交接出现歧义。");
        return { transferred: moved.length === 1, destinationTabId: moved.length ? Number(moved[0][0]) : null };
      }
      case "VPE_OPEN_PLAN_TAB": {
        // 扩展直接创建计划页；不调用网页的新建按钮，也不更改弹窗权限。
        if (!vivoPage(sender.tab?.url, "/marketing/newpromotion/plan"))
          throw new Error("只能从 vivo 广告计划列表打开新建计划页。");
        const run = runs[key];
        if (!run || run.id !== message.id || run.stage !== "plan")
          throw new Error("新建计划请求与当前待执行任务不一致，已停止。");
        if (run.batchId) {
          const batches = (await chrome.storage.session.get(BATCH_KEY))[BATCH_KEY] || {};
          const batch = batches[run.batchId];
          if (!batch || batch.status !== "running" || batch.currentIndex !== run.batchIndex)
            throw new Error("批量进度与待打开的新建计划不一致，已停止。");
        }

        const originalRun = { ...run };
        runs[key] = { ...run, stage: "opening-plan-tab", openingDirectly: true, openingAt: Date.now() };
        await chrome.storage.session.set({ [RUN_KEY]: runs });
        let created;
        try {
          created = await chrome.tabs.create({
            url: NEW_PLAN_URL, active: true,
            windowId: sender.tab.windowId, openerTabId: tabId
          });
          if (!Number.isInteger(created?.id) || created.id <= 0 || created.id === tabId ||
              (typeof created.windowId === "number" && created.windowId !== sender.tab.windowId) ||
              runs[String(created.id)])
            throw new Error("浏览器返回的新标签页身份无效或已被任务占用。");
          const destination = String(created.id);
          const moved = { ...runs[key], stage: "plan", sourceTabId: tabId };
          delete moved.openingDirectly;
          delete moved.openingAt;
          delete runs[key];
          runs[destination] = moved;
          await chrome.storage.session.set({ [RUN_KEY]: runs });
          return { opened: true, destinationTabId: created.id };
        } catch (error) {
          // 仅回收本次创建的工作标签，不触碰任何既有标签和已提交计划。
          if (Number.isInteger(created?.id) && created.id !== tabId) {
            try { await chrome.tabs.remove(created.id); }
            catch (cleanupError) { console.warn("[VPE] 新建页失败后未能关闭工作标签：", cleanupError); }
            delete runs[String(created.id)];
          }
          runs[key] = originalRun;
          await chrome.storage.session.set({ [RUN_KEY]: runs });
          throw new Error(`浏览器扩展打开新建计划页失败：${error?.message || error}`);
        }
      }
      case "VPE_SELECT_GOAL": {
        const run = runs[key];
        if (!run || run.id !== message.id || run.stage !== "plan" ||
            typeof message.goal !== "string" || message.goal !== run.payload?.goal ||
            message.goal.length > 100) {
          throw new Error("优化目标请求与当前执行任务不一致，已停止。");
        }
        return await selectNativeGoal(tabId, message.goal, message.action, message.point);
      }
      case "VPE_MATERIAL_SELECT": {
        const run = runs[key];
        if (!run || run.id !== message.id || run.stage !== "await-ad") {
          throw new Error("头像操作与当前执行任务不一致，已停止。");
        }
        const name = String(run.payload?.avatar?.name || "蓝-品牌logo")
          .replace(/\.[^.]+$/, "").trim();
        if (!name) throw new Error("当前任务尚未配置默认头像。");
        return await runMaterialAction(tabId, name);
      }
      case "VPE_STAGE": {
        const run = runs[key];
        if (!run || run.id !== message.id) throw new Error("未找到当前执行任务。");
        run.stage = message.stage;
        run.createdAt = Date.now();
        delete run.pauseReason;
        delete run.pausedAt;
        if (message.stage === "opening-plan-tab") run.openingAt = Date.now();
        await chrome.storage.session.set({ [RUN_KEY]: runs });
        return { ok: true };
      }
      case "VPE_PAUSE_SUBMISSION": {
        const run = runs[key];
        const checkpoint = message.checkpoint;
        const allowed = checkpoint === "plan-save" ? ["await-ad", "paused-plan-save"] :
          checkpoint === "ad-submit" ? ["submitting-ad", "paused-ad-submit"] : [];
        if (!run || run.id !== message.id || !allowed.includes(run.stage) ||
            !newPlanUrl(sender.tab?.url))
          throw new Error("提交暂停请求与当前广告计划不匹配。");
        run.stage = checkpoint === "plan-save" ? "paused-plan-save" : "paused-ad-submit";
        run.pauseReason = String(message.error || "页面保存/提交校验失败").slice(0, 1400);
        run.pausedAt = Date.now();
        run.createdAt = run.pausedAt;
        await chrome.storage.session.set({ [RUN_KEY]: runs });
        return { paused: true, stage: run.stage };
      }
      case "VPE_STOP_RUN": {
        // 右上角 × 和“停止任务”都终止整个批次。消息可以来自原计划页，
        // 也可以来自已经接管任务的新建广告标签页。
        const batches = (await chrome.storage.session.get(BATCH_KEY))[BATCH_KEY] || {};
        const batch = typeof message.batchId === "string" ? batches[message.batchId] : null;
        const matches = Object.entries(runs).filter(([, run]) =>
          (typeof message.id === "string" && run.id === message.id) ||
          (batch && run.batchId === batch.id));
        const allowed = (batch && batch.sourceTabId === tabId) || matches.some(([id, run]) =>
          Number(id) === tabId || run.sourceTabId === tabId);
        const resultData = (await chrome.storage.session.get(RESULT_KEY))[RESULT_KEY] || {};
        const resultEntry = Object.entries(resultData).find(([sourceId, result]) =>
          result.batchId && result.batchId === message.batchId &&
          (Number(sourceId) === tabId || Number(sourceId) === message.sourceTabId));
        if (!allowed && !resultEntry) return { stopped: false };

        const stopTabs = new Set(matches.map(([id]) => Number(id)));
        const sourceTabId = batch?.sourceTabId ??
          (resultEntry ? Number(resultEntry[0]) : Number(message.sourceTabId));
        for (const [id] of matches) delete runs[id];
        if (batch) delete batches[batch.id];
        if (resultEntry) delete resultData[resultEntry[0]];
        await chrome.storage.session.set({
          [RUN_KEY]: runs, [BATCH_KEY]: batches, [RESULT_KEY]: resultData
        });
        if (batch) await cleanBatchHandles(batch.sourceTabId, batch.id);
        for (const stoppedTabId of stopTabs) {
          try { await chrome.tabs.sendMessage(stoppedTabId,
            { type: "VPE_STOP_SIGNAL", runId: matches.find(([id]) => Number(id) === stoppedTabId)?.[1]?.id }); }
          catch { /* 标签可能已经关闭；后台任务仍已清理 */ }
        }
        if (Number.isInteger(sourceTabId) && sourceTabId > 0) {
          try { await chrome.tabs.sendMessage(sourceTabId, { type: "VPE_RESET_DRAFT", batchId: batch?.id }); }
          catch { /* 页面重载后会以空白表单重新初始化 */ }
        }
        return { stopped: true };
      }
      case "VPE_RECOVER_WINDOW": {
        // 老版本可能只关闭了提示框，仍留有 storage.session 的运行记录。
        // 只能由用户在计划列表页显式点击“结束旧任务”，不自动清掉正在执行的批次。
        if (!vivoPage(sender.tab?.url, "/marketing/newpromotion/plan"))
          throw new Error("只能从 vivo 广告计划列表页结束旧任务。");
        const batches = (await chrome.storage.session.get(BATCH_KEY))[BATCH_KEY] || {};
        const results = (await chrome.storage.session.get(RESULT_KEY))[RESULT_KEY] || {};
        const runEntries = Object.entries(runs).filter(([, run]) =>
          run.windowId === sender.tab.windowId);
        const batchEntries = Object.entries(batches).filter(([, batch]) =>
          batch.windowId === sender.tab.windowId);
        const affectedBatchIds = new Set([
          ...batchEntries.map(([id]) => id),
          ...runEntries.map(([, run]) => run.batchId).filter(Boolean)
        ]);
        for (const [id] of runEntries) delete runs[id];
        for (const [id] of batchEntries) delete batches[id];
        for (const [id, result] of Object.entries(results)) {
          if (affectedBatchIds.has(result.batchId)) delete results[id];
        }
        await chrome.storage.session.set({
          [RUN_KEY]: runs, [BATCH_KEY]: batches, [RESULT_KEY]: results
        });
        for (const batchId of affectedBatchIds) await cleanBatchHandles(tabId, batchId);
        for (const [oldTabId, run] of runEntries) {
          try { await chrome.tabs.sendMessage(Number(oldTabId),
            {type:"VPE_STOP_SIGNAL",runId:run.id}); }
          catch { /* 不影响已经完成的后台取消 */ }
        }
        return { clearedRuns: runEntries.length, clearedBatches: batchEntries.length };
      }
      case "VPE_END": {
        if (runs[key]?.id === message.id) {
          const run = runs[key];
          if (run.batchId) {
            const batches = (await chrome.storage.session.get(BATCH_KEY))[BATCH_KEY] || {};
            const batch = batches[run.batchId];
            if (batch) {
              const results = (await chrome.storage.session.get(RESULT_KEY))[RESULT_KEY] || {};
              results[String(batch.sourceTabId)] = {
                status: "failed", completed: batch.completed, total: batch.plans.length,
                failedIndex: run.batchIndex, error: String(message.error || "任务中止"),
                names: batch.plans.map(plan => plan.planName), batchId: batch.id, at: Date.now()
              };
              delete batches[run.batchId];
              await chrome.storage.session.set({ [BATCH_KEY]: batches, [RESULT_KEY]: results });
              await cleanBatchHandles(batch.sourceTabId, run.batchId);
            }
          }
          delete runs[key];
          await chrome.storage.session.set({ [RUN_KEY]: runs });
        }
        return { ok: true };
      }
      default:
        return { ignored: true };
    }
  }).then(result => respond({ ok: true, ...result })).catch(error => respond({ ok: false, error: error.message }));
  return true;
});
