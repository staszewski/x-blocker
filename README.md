# X One-Click Block

A small, dependency-free Chrome Manifest V3 extension. Adds a red **Block** button immediately beside **Follow** / **Following** in X user rows, including the **List members** dialog.

## Install

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select this folder:
   `/Users/kamilstaszewski/Projects/x-blocker`
4. Refresh any open X pages, then open the list's members.

No build, API key, or separate login is needed. It also works in Chromium browsers such as Brave.

## Use

Click **Block** beside an account. One click authorizes and completes the block, including X's confirmation dialog. The button shows **Blocking…** and only shows **Blocked** after the native X interface confirms the account is blocked. Errors show **Retry** and a message. Hover over Retry to read the error again.

The extension briefly opens an inactive profile tab, operates X's native profile menu and confirmation, then closes that tab. Your list stays open in the original tab. Several individually clicked requests run in order. Already blocked rows keep X's own Blocked button.

To unblock someone, use their X profile or X's blocked accounts settings.

## Permissions and behavior

- Runs only on HTTPS pages at x.com and www.x.com.
- Uses the scripting permission to complete the block in the temporary profile tab.
- Uses the existing X session; no cookies, passwords, tokens, analytics, remote code, or external services are read or stored.
- Only a real click on the added button initiates a block. No bulk or automatic account selection.
- Verifies the profile URL, displayed handle, and confirmation target before acting.
- Never clicks an Unblock action. A failed or unconfirmed action is never displayed as successful.
- Blocking is X's normal account block and can remove follow relationships, just as blocking in X does.
- Disabling/removing the extension does not undo blocks.

## Development and verification

Run `npm test` with Node 22 or newer. Tests use Node's built-in runner. Browser tests use a local Chromium executable (Chrome or Brave), with isolated temporary profiles and simulated X pages; no real X account is contacted or modified. Set `CHROMIUM_PATH` if the executable is elsewhere.

The native X workflow and DOM selectors can change. Automated tests cover representative X markup, not an authenticated live X session. If X changes its layout or stops background tabs from loading normally, the extension reports the error; it does not claim the account was blocked.

After editing, reload the extension in the extensions page and refresh X.

## References

- [Chrome: load an unpacked extension](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked)
- [X: blocking and unblocking accounts](https://help.x.com/en/using-x/blocking-and-unblocking-accounts)
