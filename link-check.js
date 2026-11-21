// 复用旧 LoveExtension V1.3.45「开始批量创建」时的四项基础检测规则。
// 不读取历史基准、不修改链接，不在输入过程中自动校验。
(() => {
  "use strict";

  const LABELS = { expose: "曝光监测地址", click: "点击监测地址", deeplink: "DeepLink" };
  const NESTED_KEYS = new Set([
    "url", "scheme", "ugparams", "targeturl", "redirecturl", "landingurl",
    "deeplink", "deeplinkurl", "deep_link", "h5url", "pageurl", "jumpurl", "linkurl"
  ]);
  const normalizeUrl = text => String(text || "").replace(/&amp;/gi, "&").trim();
  const normalizeParam = text => String(text || "").trim().replace(/^['"]|['"]$/g, "");
  const shortText = (text, limit = 120) => String(text || "").slice(0, limit) +
    (String(text || "").length > limit ? "…" : "");

  function decodeLayers(raw, max = 4) {
    const results = [];
    let current = normalizeUrl(raw);
    for (let i = 0; i < max; i++) {
      if (!results.includes(current)) results.push(current);
      let next;
      try { next = normalizeUrl(decodeURIComponent(current.replace(/\+/g, "%20"))); }
      catch { break; }
      if (next === current) break;
      current = next;
    }
    return results;
  }

  function looksLikeParams(text) {
    const value = normalizeUrl(text);
    return /[A-Za-z_][A-Za-z0-9_]{0,60}=/.test(value) &&
      (value.includes("&") || /^[A-Za-z_][A-Za-z0-9_]{0,60}=/.test(value));
  }

  function rawQuery(text) {
    const index = text.indexOf("?");
    return index >= 0 ? text.slice(index + 1).split("#")[0] :
      (looksLikeParams(text) ? text.split("#")[0] : "");
  }

  function urlInfo(raw) {
    try {
      if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw)) {
        const url = new URL(raw);
        return {protocol:url.protocol,host:url.hostname,path:url.pathname || ""};
      }
    } catch { /* 继续尝试与旧版相同的手动解析 */ }
    const match = raw.match(/^([A-Za-z][A-Za-z0-9+.-]*:)?\/\/([^/?#]+)([^?#]*)?/);
    return {protocol:match?.[1] || "",host:match?.[2] || "",path:match?.[3] || ""};
  }

  function parseLayer(raw, sourceKey = "") {
    const text = normalizeUrl(raw);
    const queryPart = rawQuery(text);
    const params = queryPart.split("&").filter(Boolean).map(part => {
      const equal = part.indexOf("=");
      return equal < 0 ? {key:part,valueRaw:"",valueDecoded:""} : {
        key:part.slice(0,equal).trim(),
        valueRaw:part.slice(equal+1).trim(),
        valueDecoded:decodeLayers(part.slice(equal+1).trim(),3).at(-1) || ""
      };
    });
    return {...urlInfo(text),raw:text,queryPart,sourceKey,params};
  }

  function parseTree(raw) {
    const root = parseLayer(raw);
    const layers = [root];
    function expand(layer, depth) {
      if (depth >= 4) return;
      for (const param of layer.params) {
        if (!NESTED_KEYS.has(param.key.toLowerCase())) continue;
        for (const candidate of decodeLayers(param.valueRaw)) {
          if (!/^(?:https?:\/\/|alipays:\/\/)/i.test(candidate) && !looksLikeParams(candidate)) continue;
          if (layers.some(item => item.sourceKey === param.key && item.raw === candidate)) continue;
          const nested = parseLayer(candidate, param.key);
          layers.push(nested);
          expand(nested, depth+1);
        }
      }
    }
    expand(root,0);
    return {root,layers};
  }

  function rootValues(root,key) {
    return root.params.filter(param => param.key.toLowerCase() === key.toLowerCase())
      .map(param => normalizeParam(param.valueDecoded || param.valueRaw));
  }

  function checkType(type,label,tree,errors) {
    const root = tree.root;
    const protocol = root.protocol.toLowerCase();
    const host = root.host.toLowerCase();
    const path = root.path.replace(/\/+$/, "").toLowerCase();
    if (type === "deeplink") {
      if (protocol !== "alipays:" || host !== "platformapi" || path !== "/startapp") {
        errors.push(`【${label}】链接类型错误：这里应填写 alipays://platformapi/startapp 的 DP 链接。`);
        return false;
      }
      return true;
    }
    if (!["http:","https:"].includes(protocol) || host !== "ugapi.alipay.com" || path !== "/monitor") {
      errors.push(`【${label}】链接类型错误：应填写支付宝 ugapi.alipay.com/monitor 监测链接。`);
      return false;
    }
    const actions = rootValues(root,"action");
    if (actions.length !== 1 || actions[0] !== type) {
      errors.push(`【${label}】链接类型错误：action 应为 ${type === "expose" ? "expose（曝光）" : "click（点击）"}，当前是 ${actions.join("、") || "缺失"}。`);
      return false;
    }
    return true;
  }

  function checkSyntax(label,raw,tree,errors) {
    const issues = [];
    const add = issue => { if (!issues.includes(issue)) issues.push(issue); };
    if (/\s/.test(raw)) add("存在空格或换行");
    if (/[＆？＝％＃]/.test(raw)) add("包含中文全角连接符");
    if (/%(?![\da-fA-F]{2})/.test(raw)) add("百分号编码格式不正确");
    if (/&&|\?&/.test(raw)) add("出现多余的 & 连接符");
    if (/[?&]$/.test(raw)) add("链接末尾残留 ? 或 &");

    // 只检查外层查询串，避免将 ugParams 编码内容里的 & 误判为连接符。
    for (const part of tree.root.queryPart.split("&")) {
      if (!part) continue;
      const equal = part.indexOf("=");
      if (equal < 0) { add(`字段缺少 =：${shortText(part,65)}`); continue; }
      const key = part.slice(0,equal);
      const value = part.slice(equal+1);
      if (!key || /[\s?#/]/.test(key)) add(`参数名称异常：${shortText(key,50) || "空字段名"}`);
      if (!NESTED_KEYS.has(key.toLowerCase()) && key.toLowerCase() !== "page") {
        const glued = value.match(/(?:partnerId|partnerld|ugParams|requestFrom|taskId|campaignid|clickid|accountid|adid|cid|timestamp|pid|action)=/i);
        if (glued) add(`疑似少了 &，${key} 与 ${glued[0].slice(0,-1)} 字段粘连（${shortText(part,95)}）`);
      }
    }
    if (!issues.length) return true;
    errors.push(`【${label}】链接格式异常：${issues.join("；")}。请检查删除 partnerId 时是否误删连接符。`);
    return false;
  }

  function checkPartnerId(label,tree,errors) {
    if (tree.root.params.some(param => /^partner(?:id|ld)$/i.test(param.key)))
      errors.push(`【${label}】partnerId 未完整删除：请把整个参数（含正确一侧的 &）删除，保留相邻字段之间的一个 &。`);
  }

  function channels(tree) {
    const result = rootValues(tree.root,"requestFrom").filter(Boolean)
      .map(value => ({field:"requestFrom",value}));
    for (const layer of tree.layers) {
      if (layer.sourceKey.toLowerCase() !== "ugparams") continue;
      for (const param of layer.params) {
        if (param.key.toLowerCase() !== "media") continue;
        const value = normalizeParam(param.valueDecoded || param.valueRaw);
        if (value) result.push({field:"ugParams.media",value});
      }
    }
    return result;
  }

  function checkChannels(checked,errors) {
    const types = ["expose","click","deeplink"];
    const entries = types.flatMap(type => channels(checked[type].tree)
      .map(item => ({type,...item})));
    const missing = types.filter(type => !entries.some(item => item.type === type));
    const distinct = [...new Set(entries.map(item => item.value.toLowerCase()))];
    const brief = {expose:"曝光",click:"点击",deeplink:"DP"};
    const summary = distinct.map(value => `${value}（${entries.filter(item => item.value.toLowerCase() === value)
      .map(item => `${brief[item.type]}.${item.field}`).filter((item,index,all)=>all.indexOf(item)===index).join("、")}）`).join("；");
    const issues = [];
    if (missing.length) issues.push(`${missing.map(type=>brief[type]).join("、")}缺少可识别的渠道字段`);
    if (distinct.some(value => !value.startsWith("vivo"))) issues.push(`存在非 vivo 渠道：${summary}`);
    else if (distinct.length > 1) issues.push(`渠道标识不一致：${summary}`);
    if (issues.length) errors.push(`【vivo 渠道】${issues.join("；")}。`);
  }

  function taskIds(tree) {
    const values = [];
    for (const layer of tree.layers) {
      if (layer.sourceKey.toLowerCase() !== "ugparams") continue;
      for (const param of layer.params) {
        if (param.key.toLowerCase() !== "taskid") continue;
        const value = normalizeParam(param.valueDecoded || param.valueRaw);
        if (value) values.push(value);
      }
    }
    return [...new Set(values)];
  }

  function checkTaskIds(checked,errors) {
    const entries = ["expose","click","deeplink"].map(type => ({
      label:LABELS[type],values:taskIds(checked[type].tree)
    }));
    if (entries.some(item => item.values.length !== 1)) {
      errors.push(`【业务一致性】无法确认三条链接属于同一业务：${entries.map(item=>
        `${item.label}=${item.values.join("、") || "未找到"}`).join("；")}。请检查 ugParams.taskId。`);
      return;
    }
    if (new Set(entries.map(item=>item.values[0])).size !== 1)
      errors.push(`【业务一致性】三条链接的 taskId 不一致：${entries.map(item=>
        `${item.label}=${item.values[0]}`).join("；")}。`);
  }

  function validate(links) {
    const values = Object.fromEntries(Object.keys(LABELS).map(type =>
      [type,String(links?.[type] ?? "")]));
    if (Object.values(values).every(value=>!value.trim())) return [];
    const errors = [];
    const checked = {};
    for (const type of ["expose","click","deeplink"]) {
      const label = LABELS[type];
      const raw = values[type];
      if (!raw.trim()) { errors.push(`【${label}】链接不能为空。`); continue; }
      const tree = parseTree(raw);
      const validType = checkType(type,label,tree,errors);
      const validSyntax = checkSyntax(label,raw,tree,errors);
      if (type !== "deeplink") checkPartnerId(label,tree,errors);
      checked[type] = {tree,validType,validSyntax};
    }
    if (["expose","click","deeplink"].every(type =>
      checked[type]?.validType && checked[type]?.validSyntax)) {
      checkChannels(checked,errors);
      checkTaskIds(checked,errors);
    }
    return [...new Set(errors)];
  }

  globalThis.VPLinkCheck = Object.freeze({validate});
})();
