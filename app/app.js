/* ============================================================
   Cadence — app state, persistence, and timer logic
   ============================================================ */

(function () {
  "use strict";

  var CONFIG_KEY = "cadence.config.v1";
  var RUNTIME_KEY = "cadence.runtime.v1";
  var THEME_KEY = "cadence.theme.v1";
  var ALERTS_KEY = "cadence.alerts.v1";

  var TURN_OVERFLOW_CAP_FRACTION = 1.3; // fill never visually exceeds ~130% (§5.5)
  var AUTO_FAN_MS = 900;
  var SETTLE_MS = 320;
  var POP_MS = 260;
  var RIPPLE_MS = 450;

  var TINT_CAP_SECONDS = 180; // fully saturated at 3+ minutes off pace (§5.4)
  var TINT_MAX_ALPHA = 0.16;
  var PACE_DEADZONE_SECONDS = 5;

  // ---------- Small utilities ----------

  function uid() {
    return "role-" + Math.random().toString(36).slice(2, 9);
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function partsToSeconds(min, sec) {
    var m = parseInt(min, 10);
    var s = parseInt(sec, 10);
    return (isNaN(m) ? 0 : m) * 60 + (isNaN(s) ? 0 : s);
  }

  function secondsToParts(totalSeconds) {
    var t = Math.max(0, Math.round(totalSeconds || 0));
    return { min: Math.floor(t / 60), sec: t % 60 };
  }

  function formatClock(totalSeconds) {
    var t = Math.max(0, Math.round(totalSeconds));
    var m = Math.floor(t / 60);
    var s = t % 60;
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  function ghostCountFor(remaining) {
    // 1 remaining => 0 ghosts, 2 => 1, 3+ => 2 (capped) — §5.3.
    return clamp(remaining - 1, 0, 2);
  }

  function hslToRgb(h, s, l) {
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var hp = h / 60;
    var x = c * (1 - Math.abs(hp % 2 - 1));
    var r1 = 0, g1 = 0, b1 = 0;
    if (hp < 1) { r1 = c; g1 = x; }
    else if (hp < 2) { r1 = x; g1 = c; }
    else if (hp < 3) { g1 = c; b1 = x; }
    else if (hp < 4) { g1 = x; b1 = c; }
    else if (hp < 5) { r1 = x; b1 = c; }
    else { r1 = c; b1 = x; }
    var m = l - c / 2;
    return [Math.round((r1 + m) * 255), Math.round((g1 + m) * 255), Math.round((b1 + m) * 255)];
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  var TURN_COLOR_GREEN = { h: 142, s: 0.70, l: 0.45 };
  var TURN_COLOR_DARK_ORANGE = { h: 28, s: 0.85, l: 0.38 };
  var TURN_COLOR_RED = { h: 2, s: 0.75, l: 0.45 };

  // Green -> dark orange over the allotment itself, red only once actually
  // over it. An exponential-like easing (t^4) keeps the color mostly green
  // until well past the midpoint, then swings quickly through yellow/orange
  // to reach dark orange right at 100% — rather than a linear ramp that
  // would already look orange while still comfortably within time.
  function turnColorForFraction(fraction) {
    var stopA, stopB, t;
    if (fraction <= 1) {
      stopA = TURN_COLOR_GREEN;
      stopB = TURN_COLOR_DARK_ORANGE;
      t = Math.pow(clamp(fraction, 0, 1), 4);
    } else {
      stopA = TURN_COLOR_DARK_ORANGE;
      stopB = TURN_COLOR_RED;
      t = clamp((fraction - 1) / (TURN_OVERFLOW_CAP_FRACTION - 1), 0, 1);
    }
    return hslToRgb(lerp(stopA.h, stopB.h, t), lerp(stopA.s, stopB.s, t), lerp(stopA.l, stopB.l, t));
  }

  function spawnRipple(card) {
    var ripple = document.createElement("span");
    ripple.className = "tap-ripple";
    card.appendChild(ripple);
    setTimeout(function () { ripple.remove(); }, RIPPLE_MS);
  }

  function formatDurationUnits(seconds) {
    var t = Math.max(0, Math.round(seconds));
    if (t < 60) return t + "s";
    var m = Math.floor(t / 60);
    var s = t % 60;
    return s === 0 ? m + "m" : m + "m " + s + "s";
  }

  function formatAllowance(seconds) {
    return formatDurationUnits(seconds) + " each";
  }

  // ---------- Persistence ----------

  function defaultConfig() {
    return {
      meetingBudgetSeconds: 1800,
      roles: [
        { id: uid(), name: "", secondsPerPerson: 60, count: 1 }
      ]
    };
  }

  function loadConfig() {
    try {
      var raw = localStorage.getItem(CONFIG_KEY);
      if (!raw) return defaultConfig();
      var parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.roles) || parsed.roles.length === 0) {
        return defaultConfig();
      }
      return parsed;
    } catch (e) {
      return defaultConfig();
    }
  }

  function saveConfig(config) {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  }

  function loadRuntime() {
    try {
      var raw = localStorage.getItem(RUNTIME_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || parsed.status !== "running") return null;
      return parsed;
    } catch (e) {
      return null;
    }
  }

  function saveRuntime(runtime) {
    localStorage.setItem(RUNTIME_KEY, JSON.stringify(runtime));
    if (window.CadenceSync) window.CadenceSync.broadcastState(config, runtime);
  }

  function clearRuntime() {
    localStorage.removeItem(RUNTIME_KEY);
    if (window.CadenceSync) window.CadenceSync.broadcastState(config, null);
  }

  function loadThemePreference() {
    try {
      return localStorage.getItem(THEME_KEY);
    } catch (e) {
      return null;
    }
  }

  function loadAlertPrefs() {
    try {
      var raw = localStorage.getItem(ALERTS_KEY);
      if (!raw) return { sound: true, vibration: true };
      var parsed = JSON.parse(raw);
      return {
        sound: parsed.sound !== false,
        vibration: parsed.vibration !== false
      };
    } catch (e) {
      return { sound: true, vibration: true };
    }
  }

  function saveAlertPrefs(prefs) {
    localStorage.setItem(ALERTS_KEY, JSON.stringify(prefs));
  }

  // ---------- DOM references ----------

  var el = {
    setupScreen: document.getElementById("setup-screen"),
    activeScreen: document.getElementById("active-screen"),
    setupForm: document.getElementById("setup-form"),
    budgetMin: document.getElementById("budget-min"),
    budgetSec: document.getElementById("budget-sec"),
    budgetError: document.getElementById("budget-error"),
    rolesList: document.getElementById("roles-list"),
    rolesError: document.getElementById("roles-error"),
    addRoleBtn: document.getElementById("add-role-btn"),
    roleRowTemplate: document.getElementById("role-row-template"),
    soundToggle: document.getElementById("sound-toggle"),
    vibrationToggle: document.getElementById("vibration-toggle"),
    themeToggleBtns: document.querySelectorAll(".theme-toggle-btn"),
    themeToggleIcons: document.querySelectorAll(".theme-toggle-icon"),
    settingsBtn: document.getElementById("settings-btn"),
    paceBar: document.getElementById("pace-bar"),
    paceBarFill: document.getElementById("pace-bar-fill"),
    paceBarTick: document.getElementById("pace-bar-tick"),
    paceLabel: document.getElementById("pace-label"),
    tintOverlay: document.getElementById("tint-overlay"),
    allDoneBanner: document.getElementById("all-done-banner"),
    roleGrid: document.getElementById("role-grid"),
    statElapsed: document.getElementById("stat-elapsed"),
    statRemaining: document.getElementById("stat-remaining"),
    statRemainingLabel: document.getElementById("stat-remaining-label"),
    statBudget: document.getElementById("stat-budget"),
    endMeetingBtn: document.getElementById("end-meeting-btn"),
    confirmOverlay: document.getElementById("confirm-dialog"),
    confirmTitle: document.getElementById("confirm-title"),
    confirmOkBtn: document.getElementById("confirm-ok-btn"),
    confirmCancelBtn: document.getElementById("confirm-cancel-btn"),

    syncOpenBtn: document.getElementById("sync-open-btn"),
    syncStatusBadge: document.getElementById("sync-status-badge"),
    syncDialog: document.getElementById("sync-dialog"),
    syncTabs: document.querySelectorAll(".sync-tab"),
    syncPanels: document.querySelectorAll(".sync-panel"),
    syncHostCode: document.getElementById("sync-host-code"),
    syncHostStatus: document.getElementById("sync-host-status"),
    syncHostBtn: document.getElementById("sync-host-btn"),
    syncJoinCode: document.getElementById("sync-join-code"),
    syncJoinStatus: document.getElementById("sync-join-status"),
    syncJoinBtn: document.getElementById("sync-join-btn"),
    syncDisconnectBtn: document.getElementById("sync-disconnect-btn"),
    syncCloseBtn: document.getElementById("sync-close-btn"),

    viewerScreen: document.getElementById("viewer-screen"),
    viewerPaceBarFill: document.getElementById("viewer-pace-bar-fill"),
    viewerPaceBarTick: document.getElementById("viewer-pace-bar-tick"),
    viewerPaceLabel: document.getElementById("viewer-pace-label"),
    viewerSpotlightCard: document.getElementById("viewer-spotlight-card"),
    viewerSpotlightFill: document.getElementById("viewer-spotlight-fill"),
    viewerSpotlightOverflow: document.getElementById("viewer-spotlight-overflow"),
    viewerSpotlightName: document.getElementById("viewer-spotlight-name"),
    viewerSpotlightSubtitle: document.getElementById("viewer-spotlight-subtitle"),
    viewerStatElapsed: document.getElementById("viewer-stat-elapsed"),
    viewerStatRemaining: document.getElementById("viewer-stat-remaining"),
    viewerStatRemainingLabel: document.getElementById("viewer-stat-remaining-label"),
    viewerStatBudget: document.getElementById("viewer-stat-budget"),
    viewerAlertsBtn: document.getElementById("viewer-alerts-btn"),
    viewerLeaveBtn: document.getElementById("viewer-leave-btn"),
    viewerAlertsDialog: document.getElementById("viewer-alerts-dialog"),
    viewerAlertsCloseBtn: document.getElementById("viewer-alerts-close-btn"),
    viewerSoundToggle: document.getElementById("viewer-sound-toggle"),
    viewerVibrationToggle: document.getElementById("viewer-vibration-toggle")
  };

  // ---------- Confirm dialog (reusable) ----------

  var confirmResolver = null;

  function showConfirm(message) {
    el.confirmTitle.textContent = message;
    el.confirmOverlay.hidden = false;
    return new Promise(function (resolve) {
      confirmResolver = resolve;
    });
  }

  function hideConfirm(result) {
    el.confirmOverlay.hidden = true;
    if (confirmResolver) {
      confirmResolver(result);
      confirmResolver = null;
    }
  }

  el.confirmOkBtn.addEventListener("click", function () { hideConfirm(true); });
  el.confirmCancelBtn.addEventListener("click", function () { hideConfirm(false); });

  // ---------- Theme ----------

  function applyTheme(pref) {
    if (pref === "light" || pref === "dark") {
      document.documentElement.setAttribute("data-theme", pref);
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
    var systemDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    var effectiveDark = pref === "dark" || (pref !== "light" && systemDark);
    el.themeToggleIcons.forEach(function (icon) {
      icon.className = "ti theme-toggle-icon " + (effectiveDark ? "ti-sun" : "ti-moon");
    });
  }

  function initTheme() {
    applyTheme(loadThemePreference());
  }

  el.themeToggleBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      var current = loadThemePreference();
      var systemDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
      var currentlyDark = current === "dark" || (current !== "light" && systemDark);
      var next = currentlyDark ? "light" : "dark";
      localStorage.setItem(THEME_KEY, next);
      applyTheme(next);
    });
  });

  // ---------- Alert preferences (sound / vibration) ----------

  var alertPrefs = loadAlertPrefs();

  function initAlertToggles() {
    el.soundToggle.checked = alertPrefs.sound;
    el.vibrationToggle.checked = alertPrefs.vibration;
    el.viewerSoundToggle.checked = alertPrefs.sound;
    el.viewerVibrationToggle.checked = alertPrefs.vibration;
  }

  // Sound/vibration are one shared, per-device preference with two entry
  // points (the setup screen's Alerts section, and the viewer screen's
  // alert settings) — each toggle keeps its twin in sync.
  el.soundToggle.addEventListener("change", function () {
    alertPrefs.sound = el.soundToggle.checked;
    el.viewerSoundToggle.checked = alertPrefs.sound;
    saveAlertPrefs(alertPrefs);
  });
  el.vibrationToggle.addEventListener("change", function () {
    alertPrefs.vibration = el.vibrationToggle.checked;
    el.viewerVibrationToggle.checked = alertPrefs.vibration;
    saveAlertPrefs(alertPrefs);
  });
  el.viewerSoundToggle.addEventListener("change", function () {
    alertPrefs.sound = el.viewerSoundToggle.checked;
    el.soundToggle.checked = alertPrefs.sound;
    saveAlertPrefs(alertPrefs);
  });
  el.viewerVibrationToggle.addEventListener("change", function () {
    alertPrefs.vibration = el.viewerVibrationToggle.checked;
    el.vibrationToggle.checked = alertPrefs.vibration;
    saveAlertPrefs(alertPrefs);
  });

  el.viewerAlertsBtn.addEventListener("click", function () {
    el.viewerAlertsDialog.hidden = false;
  });
  el.viewerAlertsCloseBtn.addEventListener("click", function () {
    el.viewerAlertsDialog.hidden = true;
  });

  // ---------- Setup screen ----------

  function createRoleRow(role) {
    var frag = el.roleRowTemplate.content.cloneNode(true);
    var row = frag.querySelector("[data-role-row]");
    row.dataset.id = role.id;

    var nameInput = row.querySelector(".role-name-input");
    var minInput = row.querySelector(".role-time-min");
    var secInput = row.querySelector(".role-time-sec");
    var countInput = row.querySelector(".role-count-input");

    nameInput.value = role.name || "";
    var parts = secondsToParts(role.secondsPerPerson);
    minInput.value = parts.min || "";
    secInput.value = parts.sec || "";
    countInput.value = role.count != null ? role.count : 1;

    row.querySelector(".role-remove-btn").addEventListener("click", function () {
      row.remove();
      // Keep at least one row so the form always has something to edit.
      if (el.rolesList.children.length === 0) {
        addRoleRow({ id: uid(), name: "", secondsPerPerson: 60, count: 1 });
      }
    });

    row.querySelectorAll(".stepper-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var delta = parseInt(btn.dataset.step, 10);
        var next = Math.max(0, (parseInt(countInput.value, 10) || 0) + delta);
        countInput.value = next;
      });
    });

    el.rolesList.appendChild(row);
  }

  function addRoleRow(role) {
    createRoleRow(role);
  }

  function renderSetupScreen(config) {
    var budgetParts = secondsToParts(config.meetingBudgetSeconds);
    el.budgetMin.value = budgetParts.min || "";
    el.budgetSec.value = budgetParts.sec || "";

    el.rolesList.innerHTML = "";
    config.roles.forEach(function (role) { addRoleRow(role); });
  }

  el.addRoleBtn.addEventListener("click", function () {
    addRoleRow({ id: uid(), name: "", secondsPerPerson: 60, count: 1 });
  });

  function clearFieldErrors() {
    document.querySelectorAll(".field-error").forEach(function (e) { e.hidden = true; e.textContent = ""; });
    document.querySelectorAll(".has-error").forEach(function (e) { e.classList.remove("has-error"); });
    el.budgetError.hidden = true;
  }

  function showFieldError(errorEl, targetEl, message) {
    errorEl.textContent = message;
    errorEl.hidden = false;
    if (targetEl) targetEl.classList.add("has-error");
  }

  // Reads the form, validates it, and returns { config, firstInvalidEl } —
  // config is null when validation fails.
  function readAndValidateForm() {
    clearFieldErrors();
    var firstInvalid = null;

    var budgetSeconds = partsToSeconds(el.budgetMin.value, el.budgetSec.value);
    if (budgetSeconds <= 0) {
      showFieldError(el.budgetError, el.budgetMin.parentElement, "Enter a total meeting time greater than zero.");
      firstInvalid = firstInvalid || el.budgetMin;
    }

    var roles = [];
    var rows = Array.prototype.slice.call(el.rolesList.querySelectorAll("[data-role-row]"));
    var anyValidRole = false;

    rows.forEach(function (row) {
      var nameInput = row.querySelector(".role-name-input");
      var minInput = row.querySelector(".role-time-min");
      var secInput = row.querySelector(".role-time-sec");
      var countInput = row.querySelector(".role-count-input");

      var name = nameInput.value.trim();
      var perPerson = partsToSeconds(minInput.value, secInput.value);
      var count = parseInt(countInput.value, 10) || 0;

      var isBlankRow = !name && perPerson === 0 && count === 0;
      if (isBlankRow) return; // ignore fully-empty rows silently

      var rowHasError = false;
      if (!name) {
        showFieldError(row.querySelector('[data-error="name"]'), nameInput, "Name is required.");
        firstInvalid = firstInvalid || nameInput;
        rowHasError = true;
      }
      if (perPerson <= 0) {
        showFieldError(row.querySelector('[data-error="time"]'), minInput.closest(".duration-input"), "Time per person must be greater than zero.");
        firstInvalid = firstInvalid || minInput;
        rowHasError = true;
      }
      if (count <= 0) {
        showFieldError(row.querySelector('[data-error="count"]'), countInput.closest(".stepper"), "At least one person is required.");
        firstInvalid = firstInvalid || countInput;
        rowHasError = true;
      }

      if (!rowHasError) {
        anyValidRole = true;
        roles.push({ id: row.dataset.id, name: name, secondsPerPerson: perPerson, count: count });
      }
    });

    if (!anyValidRole && rows.length > 0) {
      showFieldError(el.rolesError, null, "Add at least one role with a name, time, and at least one person.");
      firstInvalid = firstInvalid || rows[0].querySelector(".role-name-input");
    }

    if (firstInvalid) {
      firstInvalid.scrollIntoView({ behavior: "smooth", block: "center" });
      firstInvalid.focus();
      return { config: null, firstInvalidEl: firstInvalid };
    }

    return { config: { meetingBudgetSeconds: budgetSeconds, roles: roles }, firstInvalidEl: null };
  }

  el.setupForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var result = readAndValidateForm();
    if (!result.config) return;

    saveConfig(result.config);
    if (window.CadenceAudio) window.CadenceAudio.unlock();
    startMeeting(result.config);
  });

  // ---------- Runtime state ----------

  var config = null;
  var runtime = null;
  var alarmPlaying = false;
  var rafHandle = null;

  function buildInitialRuntime(cfg) {
    var roles = {};
    cfg.roles.forEach(function (r) { roles[r.id] = { remaining: r.count }; });
    return {
      status: "running",
      meetingStartedAt: Date.now(),
      roles: roles,
      activeTurn: null
    };
  }

  function startMeeting(cfg) {
    config = cfg;
    runtime = buildInitialRuntime(cfg);
    saveRuntime(runtime);
    showActiveScreen();
  }

  function showSetupScreen() {
    stopTicking();
    el.activeScreen.hidden = true;
    el.viewerScreen.hidden = true;
    el.setupScreen.hidden = false;
    el.tintOverlay.style.backgroundColor = "transparent";
    renderSetupScreen(loadConfig());
  }

  function showActiveScreen() {
    el.setupScreen.hidden = true;
    el.viewerScreen.hidden = true;
    el.activeScreen.hidden = false;
    buildRoleCards();
    startTicking();
  }

  // ---------- Role card grid ----------

  var cardRefs = {}; // roleId -> element refs

  function buildRoleCards() {
    el.roleGrid.innerHTML = "";
    cardRefs = {};

    config.roles.forEach(function (role) {
      var wrap = document.createElement("div");
      wrap.className = "stack-wrap";
      wrap.dataset.roleId = role.id;

      var ghost2 = document.createElement("div");
      ghost2.className = "ghost ghost--2";
      var ghost1 = document.createElement("div");
      ghost1.className = "ghost ghost--1";

      var card = document.createElement("button");
      card.type = "button";
      card.className = "role-card";
      card.dataset.roleId = role.id;

      var badge = document.createElement("span");
      badge.className = "role-card-badge";

      var fill = document.createElement("div");
      fill.className = "role-card-fill";

      var overflow = document.createElement("span");
      overflow.className = "role-card-overflow-label";

      var content = document.createElement("div");
      content.className = "role-card-content";
      var nameEl = document.createElement("span");
      nameEl.className = "role-card-name";
      nameEl.textContent = role.name;
      var subtitleEl = document.createElement("span");
      subtitleEl.className = "role-card-subtitle";
      subtitleEl.textContent = formatAllowance(role.secondsPerPerson);
      content.appendChild(nameEl);
      content.appendChild(subtitleEl);

      card.appendChild(badge);
      card.appendChild(fill);
      card.appendChild(overflow);
      card.appendChild(content);
      wrap.appendChild(ghost2);
      wrap.appendChild(ghost1);
      wrap.appendChild(card);
      el.roleGrid.appendChild(wrap);

      card.addEventListener("click", function () { handleCardTap(role.id); });

      cardRefs[role.id] = { wrap: wrap, card: card, badge: badge, fill: fill, overflow: overflow, name: nameEl, subtitle: subtitleEl };
    });
  }

  function handleCardTap(roleId) {
    var isActiveTurn = runtime.activeTurn && runtime.activeTurn.roleId === roleId;
    if (isActiveTurn) {
      stopTurn();
      return;
    }
    var roleState = runtime.roles[roleId];
    if (!roleState || roleState.remaining <= 0) return; // exhausted, not tappable
    if (runtime.activeTurn) stopTurn(); // implicit stop of the previous turn first
    startTurn(roleId);
  }

  function startTurn(roleId) {
    var roleConfig = config.roles.filter(function (r) { return r.id === roleId; })[0];
    runtime.activeTurn = {
      roleId: roleId,
      startedAt: Date.now(),
      allowanceSeconds: roleConfig.secondsPerPerson
    };
    saveRuntime(runtime);

    if (alertPrefs.vibration && navigator.vibrate) navigator.vibrate(15);
    var refs = cardRefs[roleId];
    if (refs) {
      spawnRipple(refs.card);
      refs.card.classList.add("just-started");
      setTimeout(function () { refs.card.classList.remove("just-started"); }, POP_MS);
    }
  }

  function stopTurn() {
    if (!runtime.activeTurn) return;
    var roleId = runtime.activeTurn.roleId;

    if (alarmPlaying && window.CadenceAudio) {
      window.CadenceAudio.stopAlarm();
      alarmPlaying = false;
    }

    var roleState = runtime.roles[roleId];
    roleState.remaining = Math.max(0, roleState.remaining - 1);
    runtime.activeTurn = null;
    saveRuntime(runtime);

    if (alertPrefs.vibration && navigator.vibrate) navigator.vibrate(15);
    var refs = cardRefs[roleId];
    if (refs) {
      spawnRipple(refs.card);
      refs.card.classList.add("is-settling");
      setTimeout(function () { refs.card.classList.remove("is-settling"); }, SETTLE_MS);

      var wrap = refs.wrap;
      wrap.dataset.ghosts = String(ghostCountFor(roleState.remaining));
      if (ghostCountFor(roleState.remaining) > 0) {
        wrap.classList.add("fan");
        setTimeout(function () { wrap.classList.remove("fan"); }, AUTO_FAN_MS);
      }
    }
  }

  // ---------- Settings / end meeting ----------

  el.settingsBtn.addEventListener("click", function () {
    if (runtime && runtime.activeTurn) {
      showConfirm("A turn is in progress. Leaving settings will end the current meeting. Continue?").then(function (ok) {
        if (ok) endMeeting();
      });
    } else if (runtime) {
      showConfirm("Editing settings will end the current meeting. Continue?").then(function (ok) {
        if (ok) endMeeting();
      });
    }
  });

  el.endMeetingBtn.addEventListener("click", function () {
    showConfirm("End this meeting and reset? This can't be undone.").then(function (ok) {
      if (ok) endMeeting();
    });
  });

  function endMeeting() {
    if (alarmPlaying && window.CadenceAudio) {
      window.CadenceAudio.stopAlarm();
      alarmPlaying = false;
    }
    clearRuntime();
    runtime = null;
    document.title = "Cadence — Standup Timer";
    showSetupScreen();
  }

  // ---------- Timer / pace loop ----------

  function expectedElapsedForProgress(nowMs) {
    // Open question §10.1: rather than compare raw wall-clock elapsed to
    // the total budget (which can never disagree with itself), pace is
    // computed against how much time the roles *actually used* would add
    // up to if everyone took exactly their allotment — this is the only
    // definition that yields a distinct "ahead/behind" signal without
    // requiring a full per-turn schedule. Completed turns count their full
    // allotment; the in-progress turn counts its elapsed time capped at its
    // own allotment, so the meeting reads as "on pace" for as long as the
    // current speaker is within their own time, only going "behind" once
    // they (or the meeting as a whole) actually run over.
    var total = 0;
    config.roles.forEach(function (role) {
      var state = runtime.roles[role.id];
      var used = role.count - state.remaining;
      total += used * role.secondsPerPerson;
    });
    if (runtime.activeTurn) {
      var turnElapsed = (nowMs - runtime.activeTurn.startedAt) / 1000;
      total += Math.min(turnElapsed, runtime.activeTurn.allowanceSeconds);
    }
    return total;
  }

  // Shared by the controller's own pace bar and the viewer screen's —
  // both derive the identical pace signal from the same config/runtime,
  // just written to different DOM elements.
  function computePaceState(nowMs, elapsedSeconds) {
    var budget = config.meetingBudgetSeconds;
    var expected = expectedElapsedForProgress(nowMs);
    var delta = expected - elapsedSeconds; // positive = ahead, negative = behind
    return {
      fillPct: clamp((elapsedSeconds / budget) * 100, 0, 100),
      tickPct: clamp((expected / budget) * 100, 0, 100),
      state: Math.abs(delta) <= PACE_DEADZONE_SECONDS ? "neutral" : (delta > 0 ? "ahead" : "behind"),
      delta: delta
    };
  }

  function applyPaceToBar(fillEl, tickEl, labelEl, pace) {
    var fillColorVar = pace.state === "ahead" ? "var(--pace-good)" : pace.state === "behind" ? "var(--pace-bad)" : "var(--pace-neutral)";
    fillEl.style.width = pace.fillPct + "%";
    tickEl.style.left = pace.tickPct + "%";
    fillEl.style.backgroundColor = fillColorVar;
    labelEl.textContent = pace.state === "neutral" ? "On pace" :
      (pace.state === "ahead" ? "Ahead by " + formatClock(Math.abs(pace.delta)) : "Behind by " + formatClock(Math.abs(pace.delta)));
  }

  function applyTint(pace) {
    var magnitude = clamp(Math.abs(pace.delta) / TINT_CAP_SECONDS, 0, 1);
    var alpha = pace.state === "neutral" ? 0 : magnitude * TINT_MAX_ALPHA;
    if (alpha === 0) {
      el.tintOverlay.style.backgroundColor = "transparent";
    } else {
      var tintRgbVar = pace.state === "behind" ? "--tint-red-rgb" : "--tint-green-rgb";
      var tintRgb = getComputedStyle(document.documentElement).getPropertyValue(tintRgbVar);
      el.tintOverlay.style.backgroundColor = "rgba(" + tintRgb + ", " + alpha.toFixed(3) + ")";
    }
  }

  function updatePaceAndTint(nowMs, elapsedSeconds) {
    var pace = computePaceState(nowMs, elapsedSeconds);
    applyPaceToBar(el.paceBarFill, el.paceBarTick, el.paceLabel, pace);
    applyTint(pace);
  }

  function applyBottomBar(elapsedEl, remainingEl, remainingLabelEl, budgetEl, elapsedSeconds) {
    var budget = config.meetingBudgetSeconds;
    var remaining = budget - elapsedSeconds;
    elapsedEl.textContent = formatClock(elapsedSeconds);
    budgetEl.textContent = formatClock(budget);
    if (remaining >= 0) {
      remainingLabelEl.textContent = "Remaining";
      remainingEl.textContent = formatClock(remaining);
    } else {
      remainingLabelEl.textContent = "Over";
      remainingEl.textContent = "+" + formatClock(Math.abs(remaining));
    }
  }

  function updateBottomBar(elapsedSeconds) {
    applyBottomBar(el.statElapsed, el.statRemaining, el.statRemainingLabel, el.statBudget, elapsedSeconds);
  }

  function updateAllDoneBanner() {
    var totalRemaining = 0;
    config.roles.forEach(function (role) { totalRemaining += runtime.roles[role.id].remaining; });
    el.allDoneBanner.hidden = !(totalRemaining === 0 && !runtime.activeTurn);
  }

  function updateRoleCards(nowMs) {
    var hasActiveTurn = !!runtime.activeTurn;
    config.roles.forEach(function (role) {
      var refs = cardRefs[role.id];
      var state = runtime.roles[role.id];
      var isActive = runtime.activeTurn && runtime.activeTurn.roleId === role.id;

      refs.card.classList.toggle("is-exhausted", !isActive && state.remaining <= 0);
      refs.badge.textContent = state.remaining;
      refs.wrap.dataset.ghosts = String(ghostCountFor(state.remaining));

      if (!isActive) {
        refs.card.classList.remove("is-active", "is-danger");
        refs.card.classList.toggle("is-dimmed", hasActiveTurn && state.remaining > 0);
        refs.fill.style.height = "0%";
        refs.fill.style.backgroundColor = "";
        refs.card.style.removeProperty("--live-rgb");
        refs.subtitle.textContent = formatAllowance(role.secondsPerPerson);
        return;
      }

      refs.card.classList.remove("is-dimmed");

      var turnElapsed = (nowMs - runtime.activeTurn.startedAt) / 1000;
      var allowance = runtime.activeTurn.allowanceSeconds;
      var fraction = turnElapsed / allowance;

      refs.card.classList.add("is-active");
      var isDanger = fraction >= 1;
      refs.card.classList.toggle("is-danger", isDanger);

      // Height is quantized to whole seconds (rather than every frame) so
      // the CSS transition on .role-card-fill reads as one eased step up
      // per second instead of a continuous, imperceptibly-smooth creep.
      var quantizedFraction = Math.floor(turnElapsed) / allowance;
      var fillPct = clamp(quantizedFraction * 100, 0, TURN_OVERFLOW_CAP_FRACTION * 100);
      refs.fill.style.height = fillPct + "%";

      var liveRgb = turnColorForFraction(fraction).join(", ");
      refs.fill.style.backgroundColor = "rgb(" + liveRgb + ")";
      refs.card.style.setProperty("--live-rgb", liveRgb);

      if (isDanger) {
        var overflowLabel = "+" + formatDurationUnits(turnElapsed - allowance);
        refs.overflow.textContent = overflowLabel;
        refs.subtitle.textContent = overflowLabel;
        if (!alarmPlaying && window.CadenceAudio && (alertPrefs.sound || alertPrefs.vibration)) {
          window.CadenceAudio.startAlarm({ sound: alertPrefs.sound, vibrate: alertPrefs.vibration });
          alarmPlaying = true;
        }
        document.title = overflowLabel + " over — Cadence";
      } else {
        refs.subtitle.textContent = formatDurationUnits(turnElapsed);
        document.title = "Cadence — Standup Timer";
      }
    });
  }

  function tick() {
    if (!runtime || runtime.status !== "running") return;
    var nowMs = Date.now();
    var elapsedSeconds = (nowMs - runtime.meetingStartedAt) / 1000;

    updatePaceAndTint(nowMs, elapsedSeconds);
    updateBottomBar(elapsedSeconds);
    updateRoleCards(nowMs);
    updateAllDoneBanner();

    rafHandle = requestAnimationFrame(tick);
  }

  function startTicking() {
    if (rafHandle) cancelAnimationFrame(rafHandle);
    rafHandle = requestAnimationFrame(tick);
  }

  function stopTicking() {
    if (rafHandle) cancelAnimationFrame(rafHandle);
    rafHandle = null;
    if (alarmPlaying && window.CadenceAudio) {
      window.CadenceAudio.stopAlarm();
      alarmPlaying = false;
    }
  }

  // ---------- Viewer screen (read-only mirror of another device) ----------
  //
  // A device is only ever one role at a time, so the viewer reuses the
  // same config/runtime variables the controller path would otherwise
  // populate locally — they're just filled in from network state instead
  // of localStorage here. Elapsed/remaining times are still derived from
  // the timestamps inside that runtime, so once a snapshot arrives this
  // renders identically to the controller's own screen, no continuous
  // network traffic required.

  var viewerRafHandle = null;
  var viewerAlarmPlaying = false;
  var viewerEverConnected = false;

  function updateViewerSpotlight(nowMs) {
    var card = el.viewerSpotlightCard;

    if (!runtime.activeTurn) {
      var totalRemaining = 0;
      config.roles.forEach(function (role) {
        var state = runtime.roles[role.id];
        totalRemaining += state ? state.remaining : 0;
      });
      card.classList.add("is-idle");
      card.classList.remove("is-active", "is-danger");
      card.style.removeProperty("--live-rgb");
      el.viewerSpotlightFill.style.height = "0%";
      el.viewerSpotlightFill.style.backgroundColor = "";
      el.viewerSpotlightOverflow.textContent = "";
      el.viewerSpotlightName.textContent = totalRemaining === 0 ? "All done" : "No one is speaking";
      el.viewerSpotlightSubtitle.textContent = "";
      document.title = "Cadence — Viewer";
      if (viewerAlarmPlaying && window.CadenceAudio) {
        window.CadenceAudio.stopAlarm();
        viewerAlarmPlaying = false;
      }
      return;
    }

    var activeRole = config.roles.filter(function (r) { return r.id === runtime.activeTurn.roleId; })[0];
    card.classList.remove("is-idle");
    card.classList.add("is-active");
    el.viewerSpotlightName.textContent = activeRole ? activeRole.name : "";

    var turnElapsed = (nowMs - runtime.activeTurn.startedAt) / 1000;
    var allowance = runtime.activeTurn.allowanceSeconds;
    var fraction = turnElapsed / allowance;
    var isDanger = fraction >= 1;
    card.classList.toggle("is-danger", isDanger);

    var quantizedFraction = Math.floor(turnElapsed) / allowance;
    var fillPct = clamp(quantizedFraction * 100, 0, TURN_OVERFLOW_CAP_FRACTION * 100);
    el.viewerSpotlightFill.style.height = fillPct + "%";

    var liveRgb = turnColorForFraction(fraction).join(", ");
    el.viewerSpotlightFill.style.backgroundColor = "rgb(" + liveRgb + ")";
    card.style.setProperty("--live-rgb", liveRgb);

    if (isDanger) {
      var overflowLabel = "+" + formatDurationUnits(turnElapsed - allowance);
      el.viewerSpotlightOverflow.textContent = overflowLabel;
      el.viewerSpotlightSubtitle.textContent = overflowLabel;
      if (!viewerAlarmPlaying && window.CadenceAudio && (alertPrefs.sound || alertPrefs.vibration)) {
        window.CadenceAudio.startAlarm({ sound: alertPrefs.sound, vibrate: alertPrefs.vibration });
        viewerAlarmPlaying = true;
      }
      document.title = overflowLabel + " over — Cadence";
    } else {
      el.viewerSpotlightSubtitle.textContent = formatDurationUnits(turnElapsed);
      document.title = "Cadence — Viewer";
    }
  }

  function renderIdleViewerState(message) {
    el.viewerSpotlightCard.classList.add("is-idle");
    el.viewerSpotlightCard.classList.remove("is-active", "is-danger");
    el.viewerSpotlightCard.style.removeProperty("--live-rgb");
    el.viewerSpotlightFill.style.height = "0%";
    el.viewerSpotlightFill.style.backgroundColor = "";
    el.viewerSpotlightOverflow.textContent = "";
    el.viewerSpotlightName.textContent = message;
    el.viewerSpotlightSubtitle.textContent = "";
    el.viewerPaceLabel.textContent = "—";
    el.viewerPaceBarFill.style.width = "0%";
    el.viewerPaceBarTick.style.left = "0%";
    el.viewerStatElapsed.textContent = "0:00";
    el.viewerStatRemaining.textContent = "0:00";
    el.viewerStatBudget.textContent = "0:00";
    el.tintOverlay.style.backgroundColor = "transparent";
  }

  function viewerTick() {
    if (!runtime || runtime.status !== "running") {
      renderIdleViewerState(viewerEverConnected ? "Meeting ended" : "Waiting for host…");
      viewerRafHandle = requestAnimationFrame(viewerTick);
      return;
    }
    viewerEverConnected = true;
    var nowMs = Date.now();
    var elapsedSeconds = (nowMs - runtime.meetingStartedAt) / 1000;
    var pace = computePaceState(nowMs, elapsedSeconds);
    applyPaceToBar(el.viewerPaceBarFill, el.viewerPaceBarTick, el.viewerPaceLabel, pace);
    applyTint(pace);
    applyBottomBar(el.viewerStatElapsed, el.viewerStatRemaining, el.viewerStatRemainingLabel, el.viewerStatBudget, elapsedSeconds);
    updateViewerSpotlight(nowMs);
    viewerRafHandle = requestAnimationFrame(viewerTick);
  }

  function startViewerTicking() {
    if (viewerRafHandle) cancelAnimationFrame(viewerRafHandle);
    viewerRafHandle = requestAnimationFrame(viewerTick);
  }

  function stopViewerTicking() {
    if (viewerRafHandle) cancelAnimationFrame(viewerRafHandle);
    viewerRafHandle = null;
    if (viewerAlarmPlaying && window.CadenceAudio) {
      window.CadenceAudio.stopAlarm();
      viewerAlarmPlaying = false;
    }
  }

  function showViewerScreen() {
    stopTicking();
    el.setupScreen.hidden = true;
    el.activeScreen.hidden = true;
    el.viewerScreen.hidden = false;
    viewerEverConnected = false;
    startViewerTicking();
  }

  // ---------- Sync dialog (host/join another device) ----------

  function setSyncStatus(statusEl, text, kind) {
    statusEl.textContent = text;
    statusEl.classList.remove("is-error", "is-ok");
    if (kind) statusEl.classList.add(kind);
  }

  function updateSyncBadge() {
    if (window.CadenceSync && window.CadenceSync.getRole() === "controller") {
      var n = window.CadenceSync.getPeerCount();
      el.syncStatusBadge.hidden = false;
      el.syncStatusBadge.textContent = n === 0 ? "Hosting" : "Hosting · " + n + (n === 1 ? " viewer" : " viewers");
    } else {
      el.syncStatusBadge.hidden = true;
    }
  }

  el.syncOpenBtn.addEventListener("click", function () {
    el.syncDialog.hidden = false;
  });
  el.syncCloseBtn.addEventListener("click", function () {
    el.syncDialog.hidden = true;
  });

  el.syncTabs.forEach(function (tab) {
    tab.addEventListener("click", function () {
      el.syncTabs.forEach(function (t) {
        t.classList.toggle("is-active", t === tab);
        t.setAttribute("aria-selected", t === tab ? "true" : "false");
      });
      el.syncPanels.forEach(function (p) {
        p.hidden = p.dataset.syncPanel !== tab.dataset.syncTab;
      });
    });
  });

  el.syncHostBtn.addEventListener("click", function () {
    var code = window.CadenceSync.generateRoomCode();
    el.syncHostCode.textContent = code.split("").join(" ");
    el.syncHostBtn.disabled = true;
    setSyncStatus(el.syncHostStatus, "Connecting…");
    window.CadenceSync.hostMeeting(code).then(function (role) {
      el.syncHostBtn.disabled = false;
      if (role === "controller") {
        setSyncStatus(el.syncHostStatus, "Hosting — waiting for viewers…", "is-ok");
        el.syncHostBtn.hidden = true;
        el.syncDisconnectBtn.hidden = false;
        updateSyncBadge();
      } else {
        window.CadenceSync.leave();
        el.syncHostCode.textContent = "— — — — —";
        setSyncStatus(el.syncHostStatus, "That code is already in use — try again.", "is-error");
      }
    }).catch(function () {
      el.syncHostBtn.disabled = false;
      setSyncStatus(el.syncHostStatus, "Couldn't connect. Check your connection and try again.", "is-error");
    });
  });

  el.syncJoinBtn.addEventListener("click", function () {
    var code = el.syncJoinCode.value.trim().toUpperCase();
    if (!code) {
      setSyncStatus(el.syncJoinStatus, "Enter a code.", "is-error");
      return;
    }
    el.syncJoinBtn.disabled = true;
    setSyncStatus(el.syncJoinStatus, "Connecting…");
    window.CadenceSync.joinMeeting(code).then(function () {
      el.syncJoinBtn.disabled = false;
      el.syncJoinCode.value = "";
      setSyncStatus(el.syncJoinStatus, "");
      el.syncDialog.hidden = true;
      showViewerScreen();
    }).catch(function () {
      el.syncJoinBtn.disabled = false;
      setSyncStatus(el.syncJoinStatus, "Couldn't connect. Check the code and your connection.", "is-error");
    });
  });

  el.syncDisconnectBtn.addEventListener("click", function () {
    window.CadenceSync.leave();
    el.syncHostBtn.hidden = false;
    el.syncDisconnectBtn.hidden = true;
    el.syncHostCode.textContent = "— — — — —";
    setSyncStatus(el.syncHostStatus, "");
    updateSyncBadge();
  });

  el.viewerLeaveBtn.addEventListener("click", function () {
    showConfirm("Leave and stop viewing this meeting?").then(function (ok) {
      if (!ok) return;
      window.CadenceSync.leave();
      stopViewerTicking();
      showSetupScreen();
    });
  });

  // ---------- Boot ----------

  function boot() {
    initTheme();
    initAlertToggles();

    if (window.CadenceSync) {
      window.CadenceSync.onStateReceived = function (payload) {
        config = payload.config;
        runtime = payload.runtime;
      };
      window.CadenceSync.onControllerLost = function () {
        renderIdleViewerState("Host disconnected");
      };
      window.CadenceSync.onPeerCountChange = updateSyncBadge;
    }

    var storedRuntime = loadRuntime();
    if (storedRuntime) {
      config = loadConfig();
      runtime = storedRuntime;
      config.roles.forEach(function (r) {
        if (!runtime.roles[r.id]) runtime.roles[r.id] = { remaining: r.count };
      });
      showActiveScreen();
    } else {
      showSetupScreen();
    }
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
