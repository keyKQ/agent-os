// Splash window controller.
//
// Status arrives by the Rust side evaluating `window.__agentosStatus({...})`
// in this window, not over Tauri's IPC. That keeps the app free of any
// capability grant at all: the main window hosts a remote origin (the Control
// UI served by the loopback gateway), and the surest way to keep IPC away from
// remote content is for the app to have no IPC surface to begin with.
//
// It also keeps this file dependency-free — a classic script with no bundler,
// no import map, and nothing to build.

(function () {
  "use strict";

  var splash = document.querySelector(".splash");
  var headline = document.getElementById("headline");
  var detail = document.getElementById("detail");
  var log = document.getElementById("log");

  // Keyed by the kebab-case phase names `supervisor::Phase` serializes to.
  var HEADLINES = {
    starting: "Starting AgentOS",
    ready: "AgentOS is ready",
    restarting: "Restarting AgentOS",
    failed: "AgentOS could not start",
    stopped: "AgentOS stopped",
  };

  window.__agentosStatus = function (status) {
    if (!status || typeof status !== "object") {
      return;
    }
    var phase = status.phase || "starting";
    splash.dataset.phase = phase;
    headline.textContent = HEADLINES[phase] || HEADLINES.starting;
    detail.textContent = status.message || "";

    // The log path is only actionable once something has gone wrong; showing
    // it during a normal two-second boot is just noise.
    var showLog = phase === "failed" && Boolean(status.log_path);
    log.hidden = !showLog;
    log.textContent = showLog ? status.log_path : "";
  };
})();
