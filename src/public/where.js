"use strict";
// Where the app is running: from the Home Screen, or in a browser tab.
//
// iOS gives a Home Screen web app its own storage, apart from Safari's. A phone
// paired in a Safari tab would keep its device token in Safari, and the app on
// the Home Screen would never see it. So pairing happens only inside the
// installed app; a tab shows how to add it to the Home Screen instead.
(function (root, make) {
  const api = make();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AirpocketWhere = api;
})(typeof self !== "undefined" ? self : globalThis, () => {
  /** Opened from the Home Screen: iOS's own flag, or the standalone display mode the manifest asks for. */
  function installed(win) {
    const nav = win && win.navigator;
    if (nav && nav.standalone === true) return true;
    try { return !!(win && typeof win.matchMedia === "function" && win.matchMedia("(display-mode: standalone)").matches); } catch { return false; }
  }
  /** The screen for a phone that is pairing a Mac: the form inside the installed app, the install steps in a tab. */
  const pairingScreen = (win) => (installed(win) ? "pair" : "install");
  return { installed, pairingScreen };
});
