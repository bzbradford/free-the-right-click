# Free the Right-Click

A Chrome extension that restores right-click menus, text selection, and
copy/paste on pages that try to block them — without breaking apps like
Google Sheets, Docs, Gutenberg, Figma, etc. that have legitimate custom
context menus or clipboard handlers.

## Install (unpacked)

1. Open `chrome://extensions`
2. Toggle **Developer mode** on (top right)
3. Click **Load unpacked**
4. Select this folder

## Usage

**Off by default, everywhere.** Right-click blocking is annoying but
rarely worth pre-empting, and running on every page means occasionally
interfering with apps that use `contextmenu` legitimately. So the
extension does nothing until you ask it to.

**Turn it on per site.** When a page blocks right-click, selection, or
copy/paste, click the toolbar icon and flip the toggle. The unblocker is
injected into the current tab immediately — no reload needed — and the
host is saved, so it stays on for that site from then on.

Enabling a domain covers its subdomains too: turning it on for
`example.com` also covers `docs.example.com`.

The popup lists every site you've enabled. Remove one with the `×`, or
add a domain by hand with `+` (useful for a site you're not currently
on). Toggling a site back off takes effect on the next page load.

## Architecture

```
manifest.json   MV3 manifest. No static content_scripts — the service
                worker registers them dynamically so the set of matched
                hosts can change at runtime.

background.js   Service worker. Reads `enabledHosts` from
                chrome.storage.local and (re)registers the unblocker via
                chrome.scripting.registerContentScripts with those hosts
                as `matches`. Re-syncs whenever storage changes.

popup.html      Toolbar popup UI.
popup.js        Popup logic. Writes `enabledHosts` to chrome.storage.local
                and injects the unblocker into the current tab on enable.

unblocker.js    The actual unblocker, injected MAIN-world at
                document_start in every frame.
```

The dynamic-registration trick: instead of declaring `"content_scripts"`
statically in the manifest, we register the script from the service
worker with `matches` built from the enabled-hosts list. Toggling a site
writes to storage, the service worker re-runs registration, and the
script starts injecting into that host. With an empty list there's no
registration at all — Chrome rejects an empty `matches` array, so
"nothing enabled" is expressed as "script unregistered".

Each enabled host becomes a `*://host/*` plus `*://*.host/*` pair, so
HTTP/HTTPS and subdomains are covered together. (Most users think in
hostnames, not origins.)

### Immediate injection

A registered content script only reaches pages loaded *after*
registration, so enabling a site would otherwise require a reload — right
when you're actively annoyed at the page. The popup therefore also calls
`chrome.scripting.executeScript` on the current tab.

Injecting late still works because the unblocker's suppression is
capture-phase listeners on `window`, which run before listeners attached
to `document` or any element regardless of registration order. Clipboard
and keydown patching are per-event and equally order-independent. The
only thing a late injection can't undo is an inline `on*` handler that
already fired — `stripInline` runs on injection, so subsequent events are
fine.

Because the same context can be injected twice (enable, disable,
re-enable without a reload), the unblocker sets a non-configurable
`window.__ftrcInstalled` flag and returns early on a second run rather
than stacking duplicate listeners.

## What the unblocker does

| Event                    | Strategy   | Notes                                                                                          |
| ------------------------ | ---------- | ---------------------------------------------------------------------------------------------- |
| `contextmenu`            | Aggressive | Page listeners never run.                                                                      |
| `selectstart`            | Aggressive\* | Text becomes selectable again.                                                               |
| `dragstart`              | Aggressive | Images/links draggable again.                                                                  |
| `keydown` (Ctrl+C/V/X/A) | Aggressive | Page can't cancel the shortcut.                                                                |
| `copy` / `cut` / `paste` | Smart      | preventDefault is committed only when the page _also_ interacts with clipboardData. See below. |

### The Sheets-compat trick

Google Sheets, Docs, and similar apps use `preventDefault()` on
`copy`/`paste` to provide their own clipboard data. A naive blocker
breaks them. We tell apart blocking from handling like this:

- `event.preventDefault()` is intercepted — sets a flag but doesn't fire
  the real preventDefault yet.
- `clipboardData.setData()` (copy/cut) and `getData`/`types`/`items`/
  `files` (paste) are wrapped to set a "clipboard interacted" flag.
- The real preventDefault is committed only when **both** flags are set.

Result:

| Page does                                        | Result                                                  |
| ------------------------------------------------ | ------------------------------------------------------- |
| `preventDefault()` only (password-field blocker) | committed = false → browser performs default copy/paste |
| `preventDefault()` + `setData()` (Sheets copy)   | committed = true → Sheets' custom clipboard wins        |
| `setData()` then `preventDefault()`              | same — order-independent                                |
| `preventDefault()` + `getData()` (Sheets paste)  | committed = true → Sheets' custom paste wins            |

`returnValue = false` and inline `onpaste="return false"` are handled
the same way via a wrapped `returnValue` accessor.

### The map/drag-widget exception (\*)

Pan/drag widgets (Leaflet, Mapbox GL, OpenLayers, resizable split-panes,
custom sliders, ...) rely on `selectstart` too — not to block copying,
but to stop the browser from highlighting text while you drag them.
Killing `selectstart` unconditionally breaks that: the widget's own
`preventDefault()` never runs, so dragging a map selects the page text
underneath it.

We tell the two apart natively, without a site whitelist: if the
element the drag started on has a `cursor` of `grab`, `grabbing`,
`move`, `all-scroll`, or one of the `*-resize` values, we treat it as a
drag widget and let the page's own `selectstart` handling win instead
of suppressing it. Anti-copy scripts have no reason to set those
cursors on body text, so this is a low-risk, per-interaction exception
rather than a per-site one.

## Permissions

- `scripting` — for `registerContentScripts` and the on-enable
  `executeScript`
- `storage` — for the enabled-sites list
- `activeTab` — to read the URL of the popup's tab
- `<all_urls>` host permission — the host set isn't known ahead of time,
  so registration needs blanket host access even though the script only
  ever runs on sites you've enabled

No network access, no analytics, no remote code. The unblocker file is
listed under `web_accessible_resources` only because Chrome requires it
when injecting into the MAIN world.

## Known limitations

- Doesn't override CSS `user-select: none`. Pure-CSS selection blocks
  remain — adding a global override would break legitimate UI like
  draggable list items.
- Chrome's own restricted pages (`chrome://`, `chrome-extension://`, the
  Web Store) aren't scriptable. The popup detects this and shows a
  message.
- Turning a site *off* needs a page reload; the already-injected
  listeners can't be removed from a live page.

## Upgrading from 1.x

v1 ran everywhere and kept a list of hosts to skip. v2 inverts that: the
list is now hosts to run on, starting empty. The old `trustedHosts` key
can't be carried over meaningfully, so it's dropped on update and you
start from off-everywhere.
