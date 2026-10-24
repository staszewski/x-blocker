import { blockProfile } from "./block-profile.js";

export function createBlockHandler(api) {
  const pending = new Map();
  let queue = Promise.resolve();

  async function perform(handle, origin, senderTab) {
    let tabId;
    try {
      const tab = await api.tabs.create({
        url: origin + "/" + handle,
        active: false,
        windowId: senderTab.windowId,
        openerTabId: senderTab.id
      });
      tabId = tab.id;
      const deadline = Date.now() + 15000;
      let ready = false;
      while (Date.now() < deadline) {
        const current = await api.tabs.get(tabId);
        if (current.status === "complete") {
          const url = new URL(current.url);
          if (url.origin !== origin ||
              url.pathname.replace(/\/$/, "").toLowerCase() !== "/" + handle.toLowerCase()) {
            throw new Error("X redirected away from the account. Sign in to X and retry.");
          }
          ready = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!ready) throw new Error("The profile took too long to load. Please retry.");
      const results = await api.scripting.executeScript({
        target: { tabId },
        func: blockProfile,
        args: [handle]
      });
      const result = results[0]?.result;
      if (!result || typeof result.ok !== "boolean") {
        throw new Error("The block could not be confirmed.");
      }
      return result;
    } catch (error) {
      return { ok: false, error: error.message || "The account could not be blocked." };
    } finally {
      if (tabId !== undefined) {
        try { await api.tabs.remove(tabId); } catch { /* Already closed. */ }
      }
    }
  }

  return function request(message, sender) {
    let url;
    try { url = new URL(sender.url); } catch { return Promise.resolve({ ok: false, error: "Invalid page." }); }
    if (sender.id !== api.runtime.id || !sender.tab || sender.frameId !== 0 ||
        url.protocol !== "https:" || !["x.com", "www.x.com"].includes(url.hostname) ||
        typeof message.handle !== "string" || !/^[A-Za-z0-9_]{1,15}$/.test(message.handle)) {
      return Promise.resolve({ ok: false, error: "Invalid block request." });
    }
    // Partition by source tab: separate signed-in contexts never share results.
    const key = sender.tab.id + ":" + message.handle.toLowerCase();
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= 20) {
      return Promise.resolve({ ok: false, error: "Please wait for the current blocks to finish." });
    }
    const task = queue.then(() => perform(message.handle, url.origin, sender.tab));
    queue = task.catch(() => {});
    pending.set(key, task);
    void task.finally(() => pending.delete(key));
    return task;
  };
}

if (globalThis.chrome?.runtime?.onMessage) {
  const request = createBlockHandler(chrome);
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "XOB_BLOCK") return false;
    request(message, sender).then(sendResponse, () =>
      sendResponse({ ok: false, error: "The extension could not complete the block. Please retry." })
    );
    return true;
  });
}
