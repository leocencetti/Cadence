/* ============================================================
   Cadence — app state, persistence, and timer logic
   ============================================================ */

(function () {
  "use strict";

  var CONFIG_KEY = "cadence.config.v1";
  var RUNTIME_KEY = "cadence.runtime.v1";
  var THEME_KEY = "cadence.theme.v1";

  var TURN_WARNING_FRACTION = 0.8; // last ~20% of allotment (§5.6)
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

  function spawnRipple(card) {
    var ripple = document.createElement("span");
    ripple.className = "tap-ripple";
    card.appendChild(ripple);
    setTimeout(function () { ripple.remove(); }, RIPPLE_MS);
  }

  function formatAllowance(seconds) {
    if (seconds < 60) return seconds + "s each";
    var m = Math.floor(seconds / 60);
    var s = seconds % 60;
    return s === 0 ? m + "m each" : m + "m " + s + "s each";
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
  }

  function clearRuntime() {
    localStorage.removeItem(RUNTIME_KEY);
  }

  function loadThemePreference() {
    try {
      return localStorage.getItem(THEME_KEY);
    } catch (e) {
      return null;
    }
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
    themeToggleBtn: document.getElementById("theme-toggle-btn"),
    themeToggleIcon: document.getElementById("theme-toggle-icon"),
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
    confirmCancelBtn: document.getElementById("confirm-cancel-btn")
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
    el.themeToggleIcon.className = effectiveDark ? "ti ti-sun" : "ti ti-moon";
  }

  function initTheme() {
    applyTheme(loadThemePreference());
  }

  el.themeToggleBtn.addEventListener("click", function () {
    var current = loadThemePreference();
    var systemDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    var currentlyDark = current === "dark" || (current !== "light" && systemDark);
    var next = currentlyDark ? "light" : "dark";
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
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
    el.setupScreen.hidden = false;
    el.tintOverlay.style.backgroundColor = "transparent";
    renderSetupScreen(loadConfig());
  }

  function showActiveScreen() {
    el.setupScreen.hidden = true;
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

      cardRefs[role.id] = { wrap: wrap, card: card, badge: badge, fill: fill, overflow: overflow, subtitle: subtitleEl };
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

    if (navigator.vibrate) navigator.vibrate(15);
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

    if (navigator.vibrate) navigator.vibrate(15);
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

  function expectedElapsedForProgress() {
    // Open question §10.1: rather than compare raw wall-clock elapsed to
    // the total budget (which can never disagree with itself), pace is
    // computed against how much time the roles *actually used* would add
    // up to if everyone took exactly their allotment — this is the only
    // definition that yields a distinct "ahead/behind" signal without
    // requiring a full per-turn schedule. A turn only counts once it has
    // been stopped (partial credit for an in-progress turn is deliberately
    // skipped to keep this simple, per the doc's "don't over-engineer").
    var total = 0;
    config.roles.forEach(function (role) {
      var state = runtime.roles[role.id];
      var used = role.count - state.remaining;
      total += used * role.secondsPerPerson;
    });
    return total;
  }

  function updatePaceAndTint(elapsedSeconds) {
    var budget = config.meetingBudgetSeconds;
    var expected = expectedElapsedForProgress();
    var delta = expected - elapsedSeconds; // positive = ahead, negative = behind

    var fillPct = clamp((elapsedSeconds / budget) * 100, 0, 100);
    var tickPct = clamp((expected / budget) * 100, 0, 100);
    el.paceBarFill.style.width = fillPct + "%";
    el.paceBarTick.style.left = tickPct + "%";

    var state = Math.abs(delta) <= PACE_DEADZONE_SECONDS ? "neutral" : (delta > 0 ? "ahead" : "behind");
    var fillColorVar = state === "ahead" ? "var(--pace-good)" : state === "behind" ? "var(--pace-bad)" : "var(--pace-neutral)";
    el.paceBarFill.style.backgroundColor = fillColorVar;
    el.paceLabel.textContent = state === "neutral" ? "On pace" :
      (state === "ahead" ? "Ahead by " + formatClock(Math.abs(delta)) : "Behind by " + formatClock(Math.abs(delta)));

    var magnitude = clamp(Math.abs(delta) / TINT_CAP_SECONDS, 0, 1);
    var alpha = state === "neutral" ? 0 : magnitude * TINT_MAX_ALPHA;
    if (alpha === 0) {
      el.tintOverlay.style.backgroundColor = "transparent";
    } else {
      var tintRgbVar = state === "behind" ? "--tint-red-rgb" : "--tint-green-rgb";
      var tintRgb = getComputedStyle(document.documentElement).getPropertyValue(tintRgbVar);
      el.tintOverlay.style.backgroundColor = "rgba(" + tintRgb + ", " + alpha.toFixed(3) + ")";
    }
  }

  function updateBottomBar(elapsedSeconds) {
    var budget = config.meetingBudgetSeconds;
    var remaining = budget - elapsedSeconds;
    el.statElapsed.textContent = formatClock(elapsedSeconds);
    el.statBudget.textContent = formatClock(budget);
    if (remaining >= 0) {
      el.statRemainingLabel.textContent = "Remaining";
      el.statRemaining.textContent = formatClock(remaining);
    } else {
      el.statRemainingLabel.textContent = "Over";
      el.statRemaining.textContent = "+" + formatClock(Math.abs(remaining));
    }
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
        refs.card.classList.remove("is-active", "is-warning", "is-danger");
        refs.card.classList.toggle("is-dimmed", hasActiveTurn && state.remaining > 0);
        refs.fill.style.height = "0%";
        refs.subtitle.textContent = formatAllowance(role.secondsPerPerson);
        return;
      }

      refs.card.classList.remove("is-dimmed");

      var turnElapsed = (nowMs - runtime.activeTurn.startedAt) / 1000;
      var allowance = runtime.activeTurn.allowanceSeconds;
      var fraction = turnElapsed / allowance;

      refs.card.classList.add("is-active");
      refs.card.classList.toggle("is-warning", fraction >= TURN_WARNING_FRACTION && fraction < 1);
      var isDanger = fraction >= 1;
      refs.card.classList.toggle("is-danger", isDanger);

      var fillPct = clamp(fraction * 100, 0, TURN_OVERFLOW_CAP_FRACTION * 100);
      refs.fill.style.height = fillPct + "%";

      if (isDanger) {
        var overflowSeconds = Math.round(turnElapsed - allowance);
        refs.overflow.textContent = "+" + overflowSeconds + "s";
        refs.subtitle.textContent = "+" + overflowSeconds + "s";
        if (!alarmPlaying && window.CadenceAudio) {
          window.CadenceAudio.startAlarm();
          alarmPlaying = true;
        }
        document.title = "+" + overflowSeconds + "s over — Cadence";
      } else {
        refs.subtitle.textContent = Math.round(turnElapsed) + "s";
        document.title = "Cadence — Standup Timer";
      }
    });
  }

  function tick() {
    if (!runtime || runtime.status !== "running") return;
    var nowMs = Date.now();
    var elapsedSeconds = (nowMs - runtime.meetingStartedAt) / 1000;

    updatePaceAndTint(elapsedSeconds);
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

  // ---------- Boot ----------

  function boot() {
    initTheme();
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
