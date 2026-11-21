(() => {
  "use strict";

  // 同源标签页共享文件句柄；IndexedDB 中只存句柄与元数据，不存 File/Blob/base64。
  // 图片或视频只在校验、上传时调用 handle.getFile() 临时读取。
  const DB_NAME = "vivoPlanAssistantPageHandlesV1";
  const STORE = "handles";
  const TTL = 4 * 60 * 60 * 1000;

  // 清除旧版缓存的完整视频 File；本版重新选素材，只使用文件句柄。
  try { indexedDB.deleteDatabase("vivoPlanAssistantPageMediaV1"); }
  catch { /* 旧库不存在或浏览器不允许删除时不阻塞使用 */ }

  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE))
          req.result.createObjectStore(STORE, { keyPath: "key" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("本地素材句柄库无法打开"));
    });
  }

  async function transaction(mode, action) {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        let result;
        try { action(tx.objectStore(STORE), value => { result = value; }); }
        catch (error) { tx.abort(); reject(error); return; }
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error || new Error("素材句柄读写失败"));
        tx.onabort = () => reject(tx.error || new Error("素材句柄操作取消"));
      });
    } finally { db.close(); }
  }

  function key(batchId, planIndex, fileIndex) {
    if (!/^[a-f0-9-]{20,}$/i.test(batchId) || !Number.isInteger(planIndex) ||
        !Number.isInteger(fileIndex) || planIndex < 0 || fileIndex < 0)
      throw new Error("素材任务标识无效");
    return `${batchId}:${planIndex}:${fileIndex}`;
  }

  function validHandle(handle) {
    return !!handle && handle.kind === "file" && typeof handle.getFile === "function";
  }

  function metaOf(file) {
    return { name: file.name, type: file.type, size: file.size, lastModified: file.lastModified };
  }

  async function getCurrentFile(entry) {
    if (!validHandle(entry?.handle)) throw new Error("本地素材文件句柄无效，请重新选择素材。");
    let file;
    try { file = await entry.handle.getFile(); }
    catch (error) {
      throw new Error(`无法读取「${entry.name || entry.handle.name}」，可能是浏览器权限失效或文件已被移动。请重新选择素材后重试。（${error?.message || error}）`);
    }
    if (!file?.size || file.name !== entry.name || file.type !== entry.type ||
        file.size !== entry.size || file.lastModified !== entry.lastModified)
      throw new Error(`「${entry.name}」已发生变化，请在列表页重新选择此素材。`);
    return file;
  }

  async function put(batchId, planIndex, fileIndex, entry) {
    if (!validHandle(entry?.handle) || !entry.name || !Number.isSafeInteger(entry.size) || entry.size < 1)
      throw new Error("当前素材不是有效文件句柄，不能保存完整文件作为替代。");
    const {handle,name,type,size,lastModified} = entry;
    await transaction("readwrite", store => store.put({
      key: key(batchId, planIndex, fileIndex), batchId, planIndex, fileIndex,
      handle, name, type, size, lastModified, createdAt: Date.now()
    }));
  }

  async function getFiles(batchId, planIndex, count, expectedMeta = []) {
    if (!Number.isInteger(count) || count < 1 || count > 5)
      throw new Error("素材数量不符合单计划 1～5 个的限制");
    const records = await transaction("readonly", (store, finish) => {
      const results = Array(count);
      for (let i = 0; i < count; i++) {
        const request = store.get(key(batchId, planIndex, i));
        request.onsuccess = () => { results[i] = request.result; };
      }
      finish(results);
    });
    if (records.some(entry => !validHandle(entry?.handle)))
      throw new Error("本地素材文件句柄记录不完整，请返回列表重新选择。");
    const files = [];
    for (let i = 0; i < count; i++) {
      const file = await getCurrentFile(records[i]);
      const expected = expectedMeta[i];
      if (expected && (expected.name !== file.name || expected.type !== file.type ||
          expected.size !== file.size || (Number.isInteger(expected.lastModified) &&
          expected.lastModified !== file.lastModified)))
        throw new Error(`「${file.name}」与批量任务原始素材不一致，已停止上传。`);
      files.push(file);
    }
    return files;
  }

  async function deleteBatch(batchId) {
    if (typeof batchId !== "string" || !batchId) return;
    await transaction("readwrite", store => {
      const request = store.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (cursor.value.batchId === batchId) cursor.delete();
        cursor.continue();
      };
    });
  }

  async function pruneStale() {
    const cutoff = Date.now() - TTL;
    await transaction("readwrite", store => {
      const request = store.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (cursor.value.createdAt < cutoff) cursor.delete();
        cursor.continue();
      };
    });
  }

  globalThis.VPMediaStore = { put, getFiles, getCurrentFile, metaOf, deleteBatch, pruneStale };
})();
