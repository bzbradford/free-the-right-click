// Free the Right-Click
// Runs in the page's MAIN world at document_start, in every frame, before
// any page script gets a chance to register handlers.
//
// Two strategies are used:
//
//   1. Aggressive unblock for contextmenu / selectstart / dragstart and the
//      Ctrl+C/V/X/A keyboard shortcuts. We stop page-level listeners from
//      running at all, in the capture phase, so they can't call
//      preventDefault.
//
//   2. Smart unblock for copy / cut / paste. Apps like Google Sheets
//      legitimately call preventDefault on these events to substitute their
//      own clipboard data. We can't just nuke their listeners or we break
//      Sheets. So instead we intercept preventDefault and only let it
//      actually run if the page also *interacts* with clipboardData
//      (setData for copy/cut, getData/items/types/files for paste). Pages
//      that just preventDefault without touching the clipboard are blockers
//      and we silently swallow their preventDefault; the browser then
//      performs the default copy/paste.

(function () {
  "use strict";

  // Stash originals before any page script can monkey-patch them.
  const realPreventDefault = Event.prototype.preventDefault;
  const realAddEventListener = EventTarget.prototype.addEventListener;
  const defineProperty = Object.defineProperty;
  const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const getPrototypeOf = Object.getPrototypeOf;

  function addCaptureListener(target, type, listener) {
    try {
      realAddEventListener.call(target, type, listener, {
        capture: true,
        passive: false,
      });
    } catch (_) {}
  }

  // ------------------------------------------------------------------
  // 1. Aggressive: contextmenu, selectstart, dragstart
  // ------------------------------------------------------------------
  // No realistic non-blocking use case for these on normal pages. Kill
  // page-level listeners by stopping immediate propagation in the
  // capture phase before they ever fire.
  const aggressiveEvents = ["contextmenu", "selectstart", "dragstart"];

  function stopAggressively(e) {
    e.stopImmediatePropagation();
  }

  aggressiveEvents.forEach((type) => {
    addCaptureListener(window, type, stopAggressively);
    addCaptureListener(document, type, stopAggressively);
  });

  // Also strip inline on* handlers as the DOM loads. Some pages do
  // <body oncontextmenu="return false"> or set document.oncontextmenu.
  const stripInline = () => {
    ["oncontextmenu", "onselectstart", "ondragstart"].forEach((prop) => {
      try {
        if (document[prop]) document[prop] = null;
        if (document.body && document.body[prop]) document.body[prop] = null;
        if (document.documentElement && document.documentElement[prop])
          document.documentElement[prop] = null;
      } catch (_) {}
    });
  };
  stripInline();
  document.addEventListener("DOMContentLoaded", stripInline, true);

  // ------------------------------------------------------------------
  // 2. Aggressive: keydown for clipboard shortcuts
  // ------------------------------------------------------------------
  // If a page preventDefaults Ctrl+C/V/X/A on keydown, the browser never
  // fires the corresponding copy/paste/cut event at all, so we have to
  // intercept earlier. We patch preventDefault on the event itself so
  // page handlers can't cancel the browser default for these shortcuts.
  addCaptureListener(window, "keydown", function (e) {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    const k = (e.key || "").toLowerCase();
    if (k !== "c" && k !== "v" && k !== "x" && k !== "a") return;

    try {
      defineProperty(e, "preventDefault", {
        value: function () {},
        configurable: false,
        writable: false,
      });
    } catch (_) {}
    try {
      defineProperty(e, "returnValue", {
        get: function () {
          return true;
        },
        set: function () {},
        configurable: false,
      });
    } catch (_) {}
  });

  // ------------------------------------------------------------------
  // 3. Smart: copy / cut / paste
  // ------------------------------------------------------------------
  // For each event:
  //   - Wrap preventDefault so calls only set a flag; the real
  //     preventDefault is deferred.
  //   - Wrap clipboardData methods so any setData (copy/cut) or
  //     getData/items/types/files (paste) access flags "legit interaction".
  //   - The real preventDefault is committed only when BOTH flags are
  //     true.
  //
  // Result:
  //   Page calls preventDefault only           → not committed, browser
  //                                              performs default action.
  //   Page calls preventDefault + setData      → committed, Sheets-style
  //                                              custom clipboard works.
  //   Page calls setData + preventDefault      → committed (order
  //                                              independent).
  //   Page calls preventDefault + getData      → committed for paste,
  //                                              Sheets-style custom paste
  //                                              works.

  const clipboardEvents = ["copy", "cut", "paste"];

  function patchClipboardEvent(e) {
    if (e.__ftrc_patched) return;
    try {
      defineProperty(e, "__ftrc_patched", {
        value: true,
        configurable: false,
        writable: false,
        enumerable: false,
      });
    } catch (_) {
      return;
    }

    const isPaste = e.type === "paste";
    let preventDefaultRequested = false;
    let clipboardInteracted = false;
    const boundRealPreventDefault = realPreventDefault.bind(e);

    function commit() {
      if (preventDefaultRequested && clipboardInteracted) {
        try {
          boundRealPreventDefault();
        } catch (_) {}
      }
    }

    try {
      defineProperty(e, "preventDefault", {
        value: function () {
          preventDefaultRequested = true;
          commit();
        },
        configurable: false,
        writable: false,
      });
    } catch (_) {}

    try {
      defineProperty(e, "returnValue", {
        get: function () {
          return !preventDefaultRequested;
        },
        set: function (v) {
          if (v === false) {
            preventDefaultRequested = true;
            commit();
          }
        },
        configurable: false,
      });
    } catch (_) {}

    const cd = e.clipboardData;
    if (!cd) return;

    // Wrap setData (relevant for copy/cut)
    try {
      if (typeof cd.setData === "function") {
        const realSetData = cd.setData.bind(cd);
        defineProperty(cd, "setData", {
          value: function () {
            clipboardInteracted = true;
            commit();
            return realSetData.apply(null, arguments);
          },
          configurable: true,
          writable: true,
        });
      }
    } catch (_) {}

    // Wrap getData (relevant for paste)
    try {
      if (typeof cd.getData === "function") {
        const realGetData = cd.getData.bind(cd);
        defineProperty(cd, "getData", {
          value: function () {
            clipboardInteracted = true;
            commit();
            return realGetData.apply(null, arguments);
          },
          configurable: true,
          writable: true,
        });
      }
    } catch (_) {}

    // For paste, accessing types/items/files also counts as legit handling
    // (Sheets reads `types` to decide between text/html and text/plain).
    if (isPaste) {
      ["types", "items", "files"].forEach((prop) => {
        try {
          const proto = getPrototypeOf(cd);
          const desc = proto && getOwnPropertyDescriptor(proto, prop);
          if (!desc || typeof desc.get !== "function") return;
          const realGetter = desc.get.bind(cd);
          defineProperty(cd, prop, {
            get: function () {
              clipboardInteracted = true;
              commit();
              return realGetter();
            },
            configurable: true,
          });
        } catch (_) {}
      });
    }
  }

  clipboardEvents.forEach((type) => {
    addCaptureListener(window, type, patchClipboardEvent);
    addCaptureListener(document, type, patchClipboardEvent);
  });
})();
