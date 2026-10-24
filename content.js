(() => {
  if (globalThis.__xobInstalled) return;
  globalThis.__xobInstalled = true;
  const states = new Map();
  const cellSelector = '[data-testid="UserCell"]';
  const followSelector = 'button[data-testid$="-follow"], button[data-testid$="-unfollow"]';
  let scanTimer;
  let toastTimer;

  function accountIn(cell) {
    function linkedHandle(link) {
      if (!link) return null;
      let url;
      try { url = new URL(link.getAttribute("href"), location.href); } catch { return null; }
      if (url.origin !== location.origin) return null;
      const match = /^\/([A-Za-z0-9_]{1,15})\/?$/.exec(url.pathname);
      return match?.[1] || null;
    }
    // A bio mention is also an @handle link. Cross-check against the avatar
    // instead of guessing when a row is incomplete or being recycled by X.
    const avatar = cell.querySelector('[data-testid^="UserAvatar-Container-"]');
    const avatarLink = avatar?.querySelector('a[href]') || avatar?.closest('a[href]');
    const handle = linkedHandle(avatarLink);
    if (!handle) return null;
    const ownLink = [...cell.querySelectorAll('a[href]')].find((link) =>
      linkedHandle(link)?.toLowerCase() === handle.toLowerCase() &&
      link.textContent.trim().toLowerCase() === "@" + handle.toLowerCase()
    );
    return ownLink ? handle : null;
  }

  function notify(message, failed = false) {
    let toast = document.getElementById("xob-notice");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "xob-notice";
      toast.setAttribute("role", "status");
      toast.setAttribute("aria-live", "polite");
      document.body.append(toast);
    }
    toast.textContent = message;
    toast.dataset.failed = String(failed);
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, failed ? 10000 : 4000);
  }

  function render(button, handle) {
    const state = states.get(handle.toLowerCase());
    const label = state?.status === "pending" ? "Blocking…" :
      state?.status === "blocked" ? "Blocked" : state?.status === "error" ? "Retry" : "Block";
    if (button.textContent !== label) button.textContent = label;
    button.dataset.handle = handle;
    button.dataset.state = state?.status || "idle";
    button.disabled = state?.status === "pending" || state?.status === "blocked";
    button.setAttribute("aria-label", label + " @" + handle);
    button.title = state?.error || (state?.status === "blocked" ?
      "@" + handle + " is blocked. Manage blocked accounts in X settings." :
      "Block @" + handle + " immediately");
  }

  async function block(event) {
    event.preventDefault();
    event.stopPropagation();
    // Page scripts cannot trigger account actions with synthetic clicks.
    if (!event.isTrusted) return;
    const button = event.currentTarget;
    const cell = button.closest(cellSelector);
    const handle = cell && accountIn(cell);
    if (!handle || button.dataset.handle !== handle) {
      scheduleScan();
      return;
    }
    const key = handle.toLowerCase();
    if (["pending", "blocked"].includes(states.get(key)?.status)) return;
    states.set(key, { status: "pending" });
    scan();
    try {
      const response = await chrome.runtime.sendMessage({ type: "XOB_BLOCK", handle });
      if (!response?.ok) throw new Error(response?.error || "The block could not be confirmed.");
      states.set(key, { status: "blocked" });
      notify("Blocked @" + handle);
    } catch (error) {
      const message = /context invalidated|receiving end|message port/i.test(error.message || "") ?
        "The extension was reloaded. Refresh X, then retry." : error.message;
      states.set(key, { status: "error", error: message || "Please retry." });
      notify("Could not confirm blocking @" + handle + ". " + (message || "Please retry."), true);
    }
    scan();
  }

  function scan() {
    for (const cell of document.querySelectorAll(cellSelector)) {
      const follow = cell.querySelector(followSelector);
      const handle = accountIn(cell);
      let button = cell.querySelector(".xob-block");
      if (!follow || !handle) {
        button?.remove();
        continue;
      }
      // X recycles list rows; read and update their account on every scan.
      if (button && button.parentElement !== follow.parentElement) {
        button.remove();
        button = null;
      }
      if (!button) {
        button = document.createElement("button");
        button.type = "button";
        button.className = "xob-block";
        button.addEventListener("click", block);
        follow.after(button);
      }
      follow.parentElement.classList.add("xob-actions");
      render(button, handle);
    }
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = undefined; scan(); }, 60);
  }
  new MutationObserver(scheduleScan).observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["href", "data-testid"]
  });
  scan();
})();
