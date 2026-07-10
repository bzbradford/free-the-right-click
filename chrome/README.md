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

**On by default everywhere.** The extension activates on every page
automatically — no configuration needed for the common case.

**Per-site disable.** If you land on an app that has its own custom
right-click menu (WordPress Gutenberg editor, Google Docs, Figma, Notion,
etc.) and the extension is interfering with it, click the toolbar icon
and toggle off "Active here." Reload the page to apply.

The popup also shows a list of all sites you've disabled and lets you
re-enable any of them with one click.

## Architecture

```
manifest.json   MV3 manifest. No static content_scripts — the service
                worker registers them dynamically so it can adjust
                excludeMatches at runtime.

background.js   Service worker. Reads `disabledHosts` from
                chrome.storage.local and (re)registers the unblocker via
                chrome.scripting.registerContentScripts with the right
                excludeMatches. Re-syncs whenever storage changes.

popup.html      Toolbar popup UI.
popup.js        Popup logic. Writes to chrome.storage.local; the service
                worker picks up the change.

unblocker.js    The actual unblocker, injected MAIN-world at document_start
                in every frame. (Unchanged from v1.)
```

The dynamic-registration trick: instead of declaring
`"content_scripts"` statically in the manifest with a fixed set of
matches, we register the script from the service worker with
`matches: ['<all_urls>']` and `excludeMatches: [...disabled origin
patterns]`. Whenever the user toggles a site, the popup writes to
storage, the service worker re-runs registration with updated
excludeMatches, and from then on the script no longer injects into that
host.

Each disabled host is converted to a `*://hostname/*` pattern so both
HTTP and HTTPS variants are excluded together. (Most users think in
hostnames, not origins.)

## What the unblocker does

| Event                    | Strategy   | Notes                                                                                          |
| ------------------------ | ---------- | ---------------------------------------------------------------------------------------------- |
| `contextmenu`            | Aggressive | Page listeners never run. Disable per-site if you want a custom menu.                          |
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

- `scripting` — for `chrome.scripting.registerContentScripts`
- `storage` — for the per-site disabled list
- `activeTab` — to read the URL of the popup's tab
- `<all_urls>` host permission — so the content script can be registered
  for any site

No network access, no analytics, no remote code. The unblocker file is
listed under `web_accessible_resources` only because Chrome requires it
when injecting via dynamic scripting into the MAIN world.

## Known limitations

- Doesn't override CSS `user-select: none`. Pure-CSS selection blocks
  remain — adding a global override would break legitimate UI like
  draggable list items.
- Chrome's own restricted pages (`chrome://`, `chrome-extension://`, the
  Web Store) aren't scriptable. The popup detects this and shows a
  message.
- Existing tabs at install time need a reload before the unblocker is
  active. New tabs are fine.

## Sites where you probably want to disable

These all have legitimate custom right-click menus or contextmenu-driven
UX. Disable per-site if you use them and notice missing behavior:

- WordPress Gutenberg admin (`*.wordpress.com`, your own
  `*/wp-admin/post.php` host)
- `docs.google.com`, `sheets.google.com`, `slides.google.com`
- `figma.com`
- `notion.so`
- `vscode.dev`, `github.dev`
- Any other Monaco/CodeMirror-based editor on the web

Copy/paste keep working everywhere thanks to the smart-clipboard logic —
the per-site disable is only needed when _contextmenu_ is the thing the
app cares about.
