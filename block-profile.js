// This function is serialized by chrome.scripting; keep it self-contained.
export async function blockProfile(handle) {
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) {
    return { ok: false, error: "Invalid account handle." };
  }
  const expected = handle.toLowerCase();
  const deadline = Date.now() + 20000;
  const mentionsTarget = new RegExp("@" + expected + "(?![A-Za-z0-9_])", "i");
  const outsideFeed = (node) => !node.closest('[data-testid="UserCell"], article');
  const visible = (node) => node && node.getClientRects().length > 0;
  const assertProfile = () => {
    if (location.pathname.replace(/\/$/, "").toLowerCase() !== "/" + expected) {
      throw new Error("X left the requested profile. Nothing else was clicked.");
    }
  };
  async function waitFor(find, message) {
    while (Date.now() < deadline) {
      assertProfile();
      const found = find();
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(message);
  }
  const main = () => document.querySelector('[data-testid="primaryColumn"]');
  const profileControl = (selector) =>
    [...(main()?.querySelectorAll(selector) || [])].find(
      (node) => outsideFeed(node) && visible(node)
    );
  const blocked = () => profileControl('button[data-testid$="-unblock"]');
  try {
    await waitFor(
      () => [...(main()?.querySelectorAll('[data-testid="UserName"]') || [])]
        .find((node) => outsideFeed(node) && visible(node) && mentionsTarget.test(node.textContent)),
      "The profile did not load. Check that you are signed in to X, then retry."
    );
    if (blocked()) return { ok: true, alreadyBlocked: true };
    const more = await waitFor(
      () => profileControl('[data-testid="userActions"]'),
      "Could not find X's profile menu. X may have changed its layout."
    );
    assertProfile();
    more.click();
    const action = await waitFor(() => {
      const menus = [...document.querySelectorAll('[role="menu"]')].filter(visible);
      const unblock = menus.flatMap((menu) => [...menu.querySelectorAll('[data-testid="unblock"]')])
        .find(visible);
      if (unblock) return { alreadyBlocked: true };
      const button = menus.flatMap((menu) => [...menu.querySelectorAll('[data-testid="block"]')])
        .find(visible);
      return button && { button };
    }, "Could not find X's Block menu item. No other menu action was selected.");
    if (action.alreadyBlocked) return { ok: true, alreadyBlocked: true };
    assertProfile();
    action.button.click();
    const confirm = await waitFor(() => {
      const button = document.querySelector('[data-testid="confirmationSheetConfirm"]');
      if (!visible(button)) return null;
      const dialog = button.closest('[role="alertdialog"], [role="dialog"]');
      if (!dialog || !mentionsTarget.test(dialog.textContent)) {
        throw new Error("The confirmation did not identify @" + handle + ". It was not accepted.");
      }
      return button;
    }, "X did not show a block confirmation. Please check the account and retry.");
    assertProfile();
    confirm.click();
    await waitFor(
      blocked,
      "X did not confirm the block. Check the profile before retrying."
    );
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message || "The block could not be confirmed." };
  }
}
