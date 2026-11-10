// All interactions are routed through the restricted miniCall bridge. No Voice credentials or web APIs used.
(() => {
  "use strict";
  const api = window.miniCall;
  const $ = (id) => document.getElementById(id);
  let state = { phase: "idle" };
  let lastError = false;
  let feedbackUntil = 0;
  const pending = new Set(); // Do not send repeated digits while one DTMF request is in flight.

  function elapsed(since) {
    // Local stopwatch: useful indication, not an authoritative telecom call-duration counter.
    if (!Number.isFinite(since) || since <= 0) return "—";
    const seconds = Math.max(0, Math.floor((Date.now() - since) / 1000));
    const mm = Math.floor(seconds / 60);
    const ss = String(seconds % 60).padStart(2, "0");
    return mm >= 60
      ? `${Math.floor(mm / 60)}:${String(mm % 60).padStart(2, "0")}:${ss}`
      : `${mm}:${ss}`;
  }

  function feedback(message, error = false) {
    $("feedback").textContent = String(message || "").slice(0, 160);
    $("feedback").classList.toggle("error", error);
    feedbackUntil = Date.now() + 4800;
    lastError = error;
  }

  function render() {
    const phase = state.phase || "idle";
    const live = phase !== "idle" && !state.preview;
    const isIncoming = phase === "incoming";
    // After digit 1 accepts a call, 1 / 2 are ordinary DTMF keys, not screening choices.
    const isScreenedIncoming =
      phase === "screening" && state.direction !== "outgoing";
    $("screening-section").hidden = !isScreenedIncoming;
    const phaseTitle = {
      incoming: "Incoming",
      outgoing: "Calling…",
      active: "In call",
      screening: "Screening",
      idle: "No active call",
    };
    $("call-state").textContent = state.preview
      ? "Preview mode · no live call"
      : phaseTitle[phase] || "Call";
    $("call-name").textContent =
      state.party || (phase === "idle" ? "Google Voice" : "Google Voice call");
    $("call-timer").textContent = live
      ? elapsed(state.since)
      : state.preview
        ? "Buttons disabled in preview"
        : "Ready";

    $("led").className =
      "brand-led" + (isIncoming ? " ringing" : live ? " live" : "");
    $("answer-row").hidden = !state.canAnswer || !isIncoming;
    $("answer").disabled = !live || !state.canAnswer;
    $("decline").disabled = !live || !state.canDecline;
    // The initial Answer click can hide the in-call keypad during Google's spoken prompt.
    // Keep 1 / 2 tappable during that verified transition; the preload refuses to press
    // unrelated dialer keys if Google has not actually exposed an in-call keypad yet.
    const toneReady = live && !isIncoming; // A verified in-call keypad is required before any DTMF digit is attempted.
    $("tone-1").querySelector("strong").textContent = "Accept";
    $("tone-2").querySelector("strong").textContent = "Voicemail";
    $("tone-1").disabled = !toneReady || pending.has("tone-1");
    $("tone-2").disabled = !toneReady || pending.has("tone-2");
    $("tone-hint").textContent = "Press 1 to accept or 2 to send to voicemail.";
    $("mute").disabled = !live || isIncoming;
    $("mute").classList.toggle("is-muted", !!state.muted);
    $("mute").querySelector("span").textContent = state.muted
      ? "Unmute"
      : "Mute";
    // Stale or icon-only native buttons must not disable the mini controller's End button.
    // The trusted Google Voice preload checks the actual live DOM before acting.
    $("hangup").disabled = !live || isIncoming;
    // Even while the in-call keypad is transitioning, this opens the original Voice window.
    $("show-keypad").disabled = !live || isIncoming;
  }

  async function action(name) {
    if (pending.has(name)) return;
    pending.add(name);
    render();
    try {
      const result = await api.action(name);
      if (!result?.ok)
        feedback(
          result?.message || "Action unavailable in Google Voice.",
          true,
        );
      else if (result.message) feedback(result.message);
    } catch (error) {
      feedback(error?.message || "Could not control the call.", true);
    } finally {
      pending.delete(name);
      render();
    }
  }

  for (const id of [
    "answer",
    "decline",
    "hangup",
    "mute",
    "tone-1",
    "tone-2",
    "open-main",
    "hide",
    "show-keypad",
    "copy-diagnostics",
  ]) {
    $(id).addEventListener("click", () => action(id));
  }

  api.onState((nextState) => {
    state = nextState || { phase: "idle" };
    render();
  });
  api.onFeedback((result) =>
    feedback(result?.message || "Action complete.", result?.ok === false),
  );
  api
    .ready()
    .then((initial) => {
      state = initial || { phase: "idle" };
      render();
    })
    .catch(() => feedback("Could not connect to Voice Desktop.", true));
  // Refresh only the visible elapsed timer, without polling the Google Voice renderer.
  setInterval(() => {
    if (state.phase !== "idle" && !state.preview)
      $("call-timer").textContent = elapsed(state.since);
    if (
      Date.now() >= feedbackUntil &&
      ($("feedback").textContent || lastError)
    ) {
      $("feedback").textContent = "";
      $("feedback").classList.remove("error");
      lastError = false;
    }
  }, 1000);
  render();
})();
