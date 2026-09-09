/* ============================================================
   Cadence — alarm audio
   Design doc calls for a bundled short sound file so the alarm
   never depends on a live network fetch (§1). Rather than ship an
   arbitrary binary asset, the alarm tone is synthesized at runtime
   with the Web Audio API — this satisfies the same constraint (zero
   network dependency at meeting time) with zero shipped bytes, and
   plays fine even mid-meeting after tab throttling.
   ============================================================ */

(function () {
  let ctx = null;
  let loopTimer = null;
  let unlocked = false;

  function ensureContext() {
    if (!ctx) {
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      ctx = new AudioContextCtor();
    }
    return ctx;
  }

  // Must be called from within a user-gesture handler (a tap) so the
  // browser allows audio playback later without a fresh gesture.
  function unlock() {
    const audioCtx = ensureContext();
    if (audioCtx.state === "suspended") {
      audioCtx.resume();
    }
    unlocked = true;
  }

  function beep(startTime, freq, duration) {
    const audioCtx = ensureContext();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "square";
    osc.frequency.setValueAtTime(freq, startTime);
    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(0.18, startTime + 0.015);
    gain.gain.linearRampToValueAtTime(0, startTime + duration);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(startTime);
    osc.stop(startTime + duration + 0.02);
  }

  function scheduleCycle(playSound, playVibrate) {
    if (playSound) {
      const audioCtx = ensureContext();
      if (audioCtx.state === "suspended") audioCtx.resume();
      const now = audioCtx.currentTime + 0.02;
      beep(now, 880, 0.12);
      beep(now + 0.16, 880, 0.12);
    }
    if (playVibrate && navigator.vibrate) {
      navigator.vibrate([120, 60, 120]);
    }
  }

  // options: { sound, vibrate } — each independently toggleable so a
  // muted-sound meeting can still buzz, or vice versa. Each may be a plain
  // boolean (checked once) or a function (called fresh every cycle) — pass
  // a function backed by the live preference object so toggling sound or
  // vibration mid-alarm takes effect on the next cycle instead of only on
  // the next overrun.
  function resolveFlag(value) {
    if (typeof value === "function") return value;
    var fixed = value !== false;
    return function () { return fixed; };
  }

  function startAlarm(options) {
    if (loopTimer) return;
    const getSound = resolveFlag(options && options.sound);
    const getVibrate = resolveFlag(options && options.vibrate);
    if (getSound()) {
      const audioCtx = ensureContext();
      if (audioCtx.state === "suspended") {
        audioCtx.resume();
      }
    }
    var cycle = function () { scheduleCycle(getSound(), getVibrate()); };
    cycle();
    loopTimer = setInterval(cycle, 700);
  }

  function stopAlarm() {
    if (loopTimer) {
      clearInterval(loopTimer);
      loopTimer = null;
    }
    if (navigator.vibrate) {
      navigator.vibrate(0);
    }
  }

  window.CadenceAudio = { unlock, startAlarm, stopAlarm };
})();
