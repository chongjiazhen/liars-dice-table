// web/table.js - the browser table over dist/table.js (the host sim in wasm).
// Contract with tools/web/bridge.cpp: window.table.decide(view) -> Promise<int>,
// window.table.event(ev); Module.ccall("table_info"), Module.ccall("play_match").
//
// Events arrive synchronously from inside the wasm run, so the page queues them
// and renders the queue on a timer: each AI action gets a beat, a reveal waits
// for a click, and your turn panel opens only once the queue has drained. The
// engine is blocked in the decider meanwhile (Asyncify), so nothing is lost.
// `?fast=1` drops every delay and auto-continues reveals (the drive.js gate).
// Otherwise the pace select scales every beat (remembered in this browser).
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const STORE = { est: "ld.estimate", record: "ld.record", markers: "ld.markers", pace: "ld.pace", window: "ld.window" };
  const FAST = /[?&]fast=1/.test(location.search);
  const PACE = { slow: 1.6, normal: 1, quick: 0.5 };
  let pace = 1;
  const beat = (ms) => (FAST ? 0 : Math.round(ms * pace));
  const BEAT = 1000;         // ms per bid
  const TENSE_BEAT = 1500;   // a challenge, a duel rung, a fold, a knockout
  const HAND_BEAT = 1700;    // a new deal
  let windowSec = 2.5;       // the off-turn pause after a rival's bid; a live slider, 0 skips it

  let M = null;        // the wasm module
  let info = null;     // table_info()
  let game = null;     // the live match's state
  let pending = null;  // the resolve of the decision the page owes the engine
  let view = null;     // the decision view waiting to be shown
  let duelView = null; // a duel rung waiting to be shown
  let calzaView = null; // a calza window waiting to be shown
  let calzaTimer = null;
  let queue = [];      // events not yet rendered
  let draining = false;
  let onContinue = null;   // a reveal waiting for its click

  // ---- dice ---------------------------------------------------------------------
  // Asian dice: a big red 1, a red 4, pips closer to the centre, and the 2 and
  // the 3 on opposite diagonals so they read apart at a glance.
  const PIPS = { 1: [[1, 1]], 2: [[2, 0], [0, 2]], 3: [[0, 0], [1, 1], [2, 2]],
                 4: [[0, 0], [0, 2], [2, 0], [2, 2]], 5: [[0, 0], [0, 2], [1, 1], [2, 0], [2, 2]],
                 6: [[0, 0], [0, 1], [0, 2], [2, 0], [2, 1], [2, 2]] };
  function die(n, cls) {
    const r = n === 1 ? 4.2 : 2.1;
    const pips = (PIPS[n] || []).map(([x, y]) => "<circle cx='" + (5.5 + x * 5.5) + "' cy='" + (5.5 + y * 5.5) + "' r='" + r + "'/>").join("");
    return "<svg class='die" + (cls ? " " + cls : "") + (n === 1 ? " one" : n === 4 ? " four" : "") + "' viewBox='0 0 22 22' aria-label='" + n + "'><rect x='1' y='1' width='20' height='20' rx='4'/>" + pips + "</svg>";
  }
  function cupHtml(hand) { return hand.map((d) => die(d)).join(""); }
  // Every bid carries its mode from the engine: 斋 (ones count as ones) or 飞
  // (ones wild) in the bar, where any face can be bid either way and ones are
  // always 斋; on the ship only aces are literal (no tag otherwise, as on the
  // device). mode 0 = 飞, 1 = 斋 (bid.h's enum order).
  function modeTag(b) {
    if (!game || !game.dudo) return b.mode === 1 ? { t: "斋", title: "zhai: ones count as ones" } : { t: "飞", title: "fei: ones are wild" };
    return b.face === 1 ? { t: "aces", title: "aces count as aces" } : null;
  }
  function bidHtml(b) { const m = modeTag(b); return "<b>" + b.qty + "</b> × " + die(b.face) + (m ? " <span class='lit' title='" + m.title + "'>" + m.t + "</span>" : ""); }
  function bidText(b) { const m = modeTag(b); return b.qty + " × " + b.face + (m ? " " + m.t : ""); }

  // ---- storage ---------------------------------------------------------------
  function load(key, dflt) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : dflt; } catch (e) { return dflt; } }
  function save(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* private mode */ } }
  function markersDefault() { return { You: 40, Sol: 100, Lark: 12 }; }

  // ---- the read line -----------------------------------------------------------
  function readLine() {
    const e = load(STORE.est, null);
    if (!e || !e.n) return "The table hasn't met you yet - it takes your measure at the end of each match.";
    const bluff = e.br > 0.4 ? "bluff often" : e.br < 0.15 ? "rarely bluff" : "bluff now and then";
    const call = e.ct > 0.5 ? "call thin" : e.ct < 0.25 ? "call only when sure" : "call when it's close";
    return "They think you " + bluff + " and " + call + " (" + e.n + " hands remembered).";
  }
  function renderRead() { $("readline").textContent = readLine(); }
  function renderRecord() {
    const rec = load(STORE.record, {});
    const parts = Object.keys(rec).sort().map((h) => h + " " + rec[h].w + "-" + rec[h].l);
    const streak = load(STORE.record + ".streak", 0);
    $("record").textContent = parts.length ? "Tables with: " + parts.join(" · ") + (streak ? " · streak " + (streak > 0 ? "W" : "L") + Math.abs(streak) : "") : "";
  }

  // ---- setup --------------------------------------------------------------------
  function format() { return document.querySelector("input[name=format]:checked").value; }
  function rosterRows() {
    // One fixed order, bar cast then ship cast, whatever the format: the list
    // is a roster, not a suggestion. The format only picks the opening seats.
    const bar = info.bar.map((r, i) => Object.assign({ rid: 1, idx: i }, r));
    const ship = info.ship.map((r, i) => Object.assign({ rid: 0, idx: i }, r));
    return bar.concat(ship);
  }
  const MAX_RIVALS = 5;
  let seatOrder = [];   // rival keys "rid:idx" in turn order after you (seat 1, 2, ...)
  const keyOf = (r) => r.rid + ":" + r.idx;
  function isIou() { return $("iou").checked && format() === "dudo"; }
  // A fresh seating: the format's own cast, three of them (the measured
  // four-seat table). IOU mode seats the crew and the house first, always.
  function renderRivals(fresh) {
    const rows = rosterRows();
    const home = format() === "dudo" ? 0 : 1;
    if (fresh) seatOrder = rows.filter((r) => r.rid === home).slice(0, 3).map(keyOf);
    if (isIou()) {
      const crew = rows.filter((r) => r.rid === 0).map(keyOf);
      seatOrder = crew.concat(seatOrder.filter((k) => crew.indexOf(k) < 0)).slice(0, MAX_RIVALS);
    }
    const box = $("rivals"); box.innerHTML = "";
    rows.forEach((r) => {
      const key = keyOf(r);
      const forced = isIou() && r.rid === 0;
      const l = document.createElement("label");
      const c = document.createElement("input"); c.type = "checkbox"; c.value = key; c.checked = seatOrder.indexOf(key) >= 0; c.disabled = forced;
      c.addEventListener("change", () => {
        if (c.checked) { if (seatOrder.indexOf(key) < 0) seatOrder.push(key); }   // a new pick takes the last chair
        else seatOrder = seatOrder.filter((k) => k !== key);
        renderSeating();
      });
      l.appendChild(c); l.appendChild(document.createTextNode(" " + r.name));
      box.appendChild(l);   // no home-table tag: the log's cfg line carries the roster id for the reader who needs it
    });
    renderSeating();
  }
  // The chairs in turn order, you first; each rival's chair moves left or
  // right or empties. The checkboxes above mirror it.
  function renderSeating() {
    const rows = rosterRows();
    const full = seatOrder.length >= MAX_RIVALS;
    const isCrew = (k) => isIou() && k.startsWith("0:");
    document.querySelectorAll("#rivals input").forEach((b) => { b.disabled = isCrew(b.value) || (!b.checked && full); });
    const box = $("seating"); box.innerHTML = "";
    const you = document.createElement("span"); you.className = "chair you"; you.textContent = "You"; box.appendChild(you);
    const mk = (t, title, on) => { const b = document.createElement("button"); b.type = "button"; b.textContent = t; b.title = title; b.addEventListener("click", on); return b; };
    seatOrder.forEach((key, i) => {
      const r = rows.find((x) => keyOf(x) === key);
      const arrow = document.createElement("span"); arrow.className = "arrow"; arrow.textContent = "\u2192"; box.appendChild(arrow);
      const ch = document.createElement("span"); ch.className = "chair";
      ch.appendChild(document.createTextNode(r.name + " "));
      const swap = (j) => { const k = seatOrder[i]; seatOrder[i] = seatOrder[j]; seatOrder[j] = k; renderSeating(); };
      // In IOU mode the crew keeps the first chairs (the engine sorts them there anyway).
      const left = mk("\u25c0", "earlier in the turn order", () => swap(i - 1)); left.disabled = i === 0 || (isCrew(key) !== isCrew(seatOrder[i - 1]));
      const right = mk("\u25b6", "later in the turn order", () => swap(i + 1)); right.disabled = i === seatOrder.length - 1 || (isCrew(key) !== isCrew(seatOrder[i + 1]));
      ch.appendChild(left); ch.appendChild(right);
      if (!isCrew(key)) ch.appendChild(mk("\u00d7", "stand up", () => { seatOrder = seatOrder.filter((k) => k !== key); document.querySelector("#rivals input[value='" + key + "']").checked = false; renderSeating(); }));
      box.appendChild(ch);
    });
    const n = seatOrder.length;
    $("play").disabled = n === 0;
    $("play").textContent = n === 0 ? "Seat a rival" : "Deal (table of " + (n + 1) + ")";
  }
  // What each house rule does, in the page's own words (the device carries the
  // in-character teach cards; this is the plain page 2 of each). Keyed by the
  // engine's short name so the list order stays the engine's.
  const RULE_HELP = {
    "surrender": "In a duel the challenger may fold instead of seeing the cups: it pays one (a drink or a die), the bid is deemed to have held, and nothing is revealed. A bidder never folds its own bid at this table.",
    "chain-kill": "A challenge can sweep a run of recent bidders at once, at a depth you pick. Each swept seat answers on its own last bid: stand, escalate, or fold the link for one. Every bid that was wrong pays; if nobody stands, nothing is revealed and the sweeper pays every penalty.",
    "direction": "The seat that opens the hand chooses which way the bidding runs.",
    "must-pairs": "A cup with no pair is shaken again until it pairs. Bar only: with the ship's shrinking dice pool a reroll leaks nearly the whole hand.",
    "counter-kill": "A challenged bidder can double the stake instead of lifting; the challenger can double back or fold. The loser pays the stake that stood, in full; it runs as deep as nerve allows, with a hard stop at 32x.",
    "+2 reverse": "Raising the count by two or more reverses the direction of play.",
    "palifico": "When a player drops to their last die, the next round is theirs: aces count only as aces, no wilds, and the face they open on is locked for the round, so the others may only raise the quantity (a seat that has had its own palifico round and is down to one die keeps the right to change the face). Once per player per match, never heads-up. Ship only: the bar's fixed five dice never reach one die.",
    "calza": "After a rival's bid, anyone off-turn may call the count exact, with three or more still in and no palifico round running. Spot on heals a die (sobers a drink in the bar; nothing if the cup is full or the caller is sober); a miss costs one, and a miss at the brink is a knockout.",
    "out-of-turn challenge": "After a rival's bid you may challenge it at once, without waiting for your turn."
  };
  let helpOpen = null;   // the rule whose help is showing
  function showRuleHelp(r) {
    helpOpen = helpOpen === r.id ? null : r.id;
    const p = $("ruleHelp");
    p.hidden = helpOpen === null;
    if (helpOpen !== null) p.innerHTML = "<b>" + r.name + "</b> - " + (RULE_HELP[r.name] || "No note for this rule yet.");
    document.querySelectorAll("#rules .why").forEach((b) => b.classList.toggle("on", parseInt(b.dataset.rule, 10) === helpOpen));
  }
  function renderRules() {
    const box = $("rules"); box.innerHTML = "";
    helpOpen = null; $("ruleHelp").hidden = true;
    const home = format() === "dudo" ? "ship" : "bar";
    info.rules.forEach((r) => {
      const l = document.createElement("label");
      l.title = RULE_HELP[r.name] || "";
      const c = document.createElement("input"); c.type = "checkbox"; c.value = r.id; c.checked = false;   // the bare table: every difficulty number was measured at mask 0
      c.addEventListener("change", rulesSummary);
      l.appendChild(c); l.appendChild(document.createTextNode(" " + r.name + " "));
      // The only biome that survives on the web is the table's dice economy, so
      // the only tag is the one that gates on it: the two rules that cannot port.
      if (!r.portable) { const s = document.createElement("span"); s.className = "hint"; s.textContent = r.biome + " only"; l.appendChild(s); }
      if (!r.portable && r.biome !== home) c.disabled = true;
      const w = document.createElement("button"); w.type = "button"; w.className = "why"; w.textContent = "?"; w.dataset.rule = r.id; w.title = "what this rule does";
      w.addEventListener("click", (e) => { e.preventDefault(); showRuleHelp(r); });
      l.appendChild(w);
      box.appendChild(l);
    });
    rulesSummary();
  }
  function rulesSummary() {
    const on = Array.from(document.querySelectorAll("#rules input:checked")).map((c) => info.rules[c.value].name);
    $("rulesSummary").textContent = on.length ? on.join(", ") : "none";
  }
  function rulesConfig() {
    let mask = 0, ck = 0;
    document.querySelectorAll("#rules input:checked").forEach((c) => {
      const r = info.rules[c.value];
      if (r.masked) mask |= (1 << r.id); else ck = 1;   // Surrender + CounterKill are the duel toggle
    });
    return { mask, ck };
  }
  function onFormat() {
    if (format() !== "dudo") $("iou").checked = false;
    $("iou").disabled = format() !== "dudo";
    renderRivals(true); renderRules();   // a new format seats its own cast first
  }

  // ---- the table ----------------------------------------------------------------
  function seatName(s) { return s >= 0 && s < game.n ? game.names[s] : "nobody"; }
  function log(line) { game.log.push(line); $("log").textContent = game.log.join("\n"); $("log").scrollTop = 1e9; }

  function renderSeats() {
    const box = $("seatsView"); box.innerHTML = "";
    for (let s = 0; s < game.n; s++) {
      const d = document.createElement("div");
      d.className = "seat" + (s === 0 ? " you" : "") + (s === game.turn ? " turn" : "") + (game.alive[s] ? "" : " out");
      // The bar shows the count and the danger flag, never the cap (design
      // 2026-07-21 "hidden C, visible count"): the flag lights on the first of
      // the six drinks up to the cap, one of which is the secret last one.
      const danger = !game.dudo && game.alive[s] && game.dice[s] >= game.tol[s] - 5;
      const stat = game.dudo ? (game.dice[s] + (game.dice[s] === 1 ? " die" : " dice"))
                 : (game.dice[s] + (game.dice[s] === 1 ? " drink" : " drinks") + (danger ? " <span class='danger' title='in the last six drinks: one of them, drawn at the deal and kept secret, is the last'>in danger</span>" : ""));
      const mk = game.iou && game.markers[s] >= 0 ? " · " + game.markers[s] + " markers" : "";
      d.innerHTML = "<div class='name'>" + seatName(s) + "</div><div class='stat'>" + stat + mk + "</div><div class='last'>" + (game.last[s] || "&nbsp;") + "</div>";
      box.appendChild(d);
    }
    $("standing").innerHTML = game.standing
      ? "Standing: " + bidHtml(game.standing) + " <span class='hint'>by " + seatName(game.bidder) + "</span>"
      : (game.over ? "" : "Hand " + (game.hand + 1) + " · no bid yet");
  }

  // Apply one event to the state and the screen. Returns the delay before the next.
  function apply(ev) {
    if (ev.dice) game.dice = ev.dice.slice();
    let wait = beat(BEAT);
    const stakeText = (n) => (n > 1 ? " at " + n + "x" : "");
    switch (ev.kind) {
      case "HandStart":
        game.hand = ev.hand; game.standing = null; game.bidder = -1; game.turn = ev.seat; game.stake = 1;
        game.last = game.last.map((_, s) => (game.alive[s] ? "" : "out"));
        $("reveal").hidden = true;
        log("H" + (ev.hand + 1) + " deal, " + seatName(ev.seat) + " opens" + (game.dudo ? "  dice " + ev.dice.join("/") : "  drinks " + ev.dice.join("/")));
        wait = beat(HAND_BEAT);
        break;
      case "Bid":
        game.standing = ev.bid; game.bidder = ev.seat; game.turn = ev.other;   // the engine names who acts next
        game.last[ev.seat] = "bid " + bidHtml(ev.bid);
        log("  " + seatName(ev.seat) + " bids " + bidText(ev.bid));
        break;
      case "Challenge":
        game.turn = -1;
        game.last[ev.seat] = "<span class='act'>challenges " + seatName(ev.other) + "</span>";
        log("  " + seatName(ev.seat) + " challenges " + seatName(ev.other));
        wait = beat(TENSE_BEAT);
        break;
      case "Counter":     // the bidder doubles the stake on its own bid
        game.stake = ev.count; game.turn = ev.other;
        game.last[ev.seat] = "<span class='act'>counters - " + ev.count + "x</span>";
        log("  " + seatName(ev.seat) + " counters: the stake is " + ev.count + "x");
        wait = beat(TENSE_BEAT);
        break;
      case "Escalate":    // the challenger doubles it back
        game.stake = ev.count; game.turn = ev.other;
        game.last[ev.seat] = "<span class='act'>escalates - " + ev.count + "x</span>";
        log("  " + seatName(ev.seat) + " escalates: the stake is " + ev.count + "x");
        wait = beat(TENSE_BEAT);
        break;
      case "Stand":       // the stake stands; the cups come up
        game.stake = ev.count; game.turn = -1;
        game.last[ev.seat] = "stands" + stakeText(ev.count);
        log("  " + seatName(ev.seat) + " stands" + stakeText(ev.count) + " - cups up");
        wait = beat(TENSE_BEAT);
        break;
      case "Calza":
        game.turn = -1; game.calza = ev.count > 0;
        game.last[ev.seat] = "<span class='act'>calls it exact</span>";
        log("  " + seatName(ev.seat) + " calls it exact" + (ev.count > 0 ? (game.dudo ? " - and it is (+1 die)" : " - and it is (sobers a drink)") : (game.dudo ? " - it is not (-1 die)" : " - it is not (drinks one)")));
        wait = beat(TENSE_BEAT);
        break;
      case "Reveal": {
        const box = $("reveal"); box.hidden = false;
        const cups = ev.hands.map((h, s) => h.length ? "<div class='cupline'><span class='who'>" + seatName(s) + "</span> <span class='cup'>" + cupHtml(h) + "</span></div>" : "").join("");
        const exact = game.calza !== undefined;
        const verdict = exact
          ? (game.calza ? seatName(ev.seat) + " called it exactly right." : seatName(ev.seat) + " called exact and missed.")
          : seatName(ev.seat) + " loses the hand.";
        box.innerHTML = "<div class='verdict'>" + bidHtml(ev.bid) + stakeText(game.stake) + " · <b>" + ev.count + "</b> on the table. " + verdict + "</div><div class='cups'>" + cups + "</div>" +
                        (FAST ? "" : "<button id='continue' class='primary'>Continue</button>");
        delete game.calza;
        log("  reveal" + stakeText(game.stake) + ": " + ev.count + " × " + ev.bid.face + " on the table; " + seatName(ev.seat) + (exact ? " called exact" : " loses"));
        if (!FAST) { wait = -1; $("continue").addEventListener("click", () => { $("continue").disabled = true; const c = onContinue; onContinue = null; if (c) c(); }); }
        break;
      }
      case "Surrender":
        game.turn = -1;
        game.last[ev.seat] = "<span class='act'>folds" + stakeText(ev.count) + "</span>";
        log("  " + seatName(ev.seat) + " folds " + (game.standing && ev.bid && ev.bid.qty === game.standing.qty && ev.bid.face === game.standing.face ? "the challenge" : "on " + bidText(ev.bid)) + stakeText(ev.count) + " (no reveal, reduced penalty)");
        wait = beat(TENSE_BEAT);
        break;
      case "Penalty": {
        const unit = game.dudo ? (Math.abs(ev.count) === 1 ? " die" : " dice") : (Math.abs(ev.count) === 1 ? " drink" : " drinks");
        const why = game.stake > 1 && ev.count > 1 ? " (" + game.stake + "x stake)" : "";
        game.last[ev.seat] = "pays " + ev.count + unit + why;
        log("  " + seatName(ev.seat) + " pays " + ev.count + unit + why);
        break;
      }
      case "KnockOut":
        game.alive[ev.seat] = false; game.last[ev.seat] = "<span class='act'>out</span>";
        log("  " + seatName(ev.seat) + (game.dudo ? (ev.seat === 0 ? " are out of dice" : " is out of dice") : (ev.seat === 0 ? " pass out on drink " : " passes out on drink ") + game.dice[ev.seat]) + (ev.other >= 0 ? " (to " + seatName(ev.other) + ")" : ""));
        wait = beat(TENSE_BEAT);
        break;
      case "Ledger":
        if (game.markers[ev.seat] >= 0) game.markers[ev.seat] = Math.max(0, game.markers[ev.seat] + ev.count);
        log("  " + seatName(ev.seat) + (ev.count < 0 ? " shreds " + (-ev.count) : " takes on " + ev.count) + " marker" + (Math.abs(ev.count) === 1 ? "" : "s"));
        wait = 0;
        break;
      case "MatchEnd":
        game.over = true; game.turn = -1; game.winner = ev.seat;
        log("Match over after " + ev.count + " hands: " + seatName(ev.seat) + " is the last cup standing.");
        wait = 0;
        break;
      case "Estimate":
        save(STORE.est, { ct: ev.ct, bc: ev.bc, br: ev.br, n: ev.n });
        finishMatch(ev.winner);
        wait = 0;
        break;
    }
    renderSeats();
    return wait;
  }

  function onEvent(ev) { queue.push(ev); drain(); }
  function drain() {
    if (draining) return;
    if (!queue.length) { showCalza(); showDuel(); showTurn(); return; }
    draining = true;
    const wait = apply(queue.shift());
    const next = () => { draining = false; drain(); };
    if (wait < 0) onContinue = next;
    else if (wait === 0) next();
    else setTimeout(next, wait);
  }

  // ---- your turn ----------------------------------------------------------------
  function decide(v) {
    view = v;
    return new Promise((resolve) => { pending = resolve; drain(); });
  }
  // ---- the off-turn window ------------------------------------------------------
  // The device gives the player the AI's think-pause to call exact or to
  // challenge out of turn; here the window is a timed panel that passes on
  // its own. FAST passes at once.
  function interrupt(v) {
    if (FAST || windowSec <= 0) return Promise.resolve(0);
    calzaView = v;
    return new Promise((resolve) => { pending = resolve; drain(); });
  }
  function showCalza() {
    if (!calzaView || !pending) return;
    const v = calzaView; calzaView = null;
    const heal = game.dudo ? (v.heal ? "a die back" : "nothing (your cup is full)") : (v.heal ? "sobers you a drink" : "nothing (you are sober)");
    const miss = game.dudo ? "a die" : "a drink";
    const offers = [];
    if (v.canCalza) offers.push("call it exact (a hit is " + heal + ", a miss costs " + miss + ")");
    if (v.canChallenge) offers.push("challenge it now, out of turn");
    $("calzaMsg").innerHTML = seatName(v.bidder) + " bid " + bidHtml(v.standing) + ". You may " + offers.join(", or ") + ". Your cup: <span class='cup'>" + cupHtml(v.hand) + "</span>";
    $("calzaYes").hidden = !v.canCalza;
    $("calzaChallenge").hidden = !v.canChallenge;
    $("calzaHint").textContent = "";
    $("calza").hidden = false;
    let left = Math.round(windowSec * 1000);
    const tick = () => { $("calzaHint").textContent = "passes in " + Math.ceil(left / 1000) + "s"; };
    tick();
    calzaTimer = setInterval(() => { left -= 250; if (left <= 0) answerCalza(0); else tick(); }, 250);
  }
  function answerCalza(a) {
    if (!pending) return;
    if (calzaTimer) { clearInterval(calzaTimer); calzaTimer = null; }
    const r = pending; pending = null;
    $("calza").hidden = true;
    r(a);
  }

  // ---- your rung of a duel ------------------------------------------------------
  function duel(v) {
    duelView = v;
    return new Promise((resolve) => { pending = resolve; drain(); });
  }
  function showDuel() {
    if (!duelView || !pending) return;
    const v = duelView; duelView = null;
    game.turn = 0; game.stake = v.stake;
    renderSeats();
    const unit = game.dudo ? "dice" : "drinks";
    const who = seatName(v.opponent);
    let lead;
    if (v.inSweep) {
      const link = " (link " + v.link + " of " + v.links + ")";
      lead = v.isBidder
        ? (v.stake === 1 ? who + " sweeps your bid of " + bidText(v.standing) + link + "." : who + " escalated to " + v.stake + "x on your " + bidText(v.standing) + link + ".")
        : who + " countered your sweep on their " + bidText(v.standing) + link + ": the stake is " + v.stake + "x.";
    } else {
      lead = v.isBidder
        ? (v.stake === 1 ? who + " called your " + bidText(v.standing) + "." : who + " escalated to " + v.stake + "x.")
        : who + " countered your call: the stake is " + v.stake + "x.";
    }
    $("duelMsg").innerHTML = lead + " Your cup: <span class='cup'>" + cupHtml(v.hand) + "</span>";
    $("duelStand").textContent = "Stand at " + v.stake + "x";
    $("duelStand").title = "cups up now; the loser pays " + v.stake + " " + unit;
    $("duelEscalate").hidden = !v.canEscalate;
    $("duelEscalate").textContent = "Escalate to " + v.nextStake + "x";
    $("duelEscalate").title = who + " answers; a reveal then costs the loser " + v.nextStake + " " + unit;
    $("duelFold").hidden = !v.canFold;
    $("duelFold").textContent = (v.inSweep && !v.isBidder ? "Concede the link, pay " : "Fold, pay ") + v.foldPenalty;
    $("duelFold").title = "no reveal on this bid; you pay " + v.foldPenalty + " " + (v.foldPenalty === 1 ? unit.slice(0, -1) : unit);
    $("duelHint").textContent = v.isBidder && !v.canFold ? "Your bid stands either way; you cannot fold it." : "";
    $("duel").hidden = false;
    $("duel").scrollIntoView({ block: "nearest" });
  }
  function answerDuel(a) {
    if (!pending) return;
    const r = pending; pending = null;
    $("duel").hidden = true; game.turn = -1;
    r(a);
  }
  function showTurn() {
    if (!view || !pending) return;
    const v = view; view = null;
    game.turn = 0; game.view = v;
    renderSeats();
    $("cup").innerHTML = cupHtml(v.hand);
    $("unknown").textContent = v.unknown + " dice you can't see";
    // The floor, as a fixed grid: one column per face, a 飞 row and a 斋 row in
    // the bar (one row on the ship), each cell that face's cheapest legal raise
    // in that mode, greyed when there is none. Nothing moves between turns; the
    // stepper covers any other quantity.
    const menu = $("menu"); menu.innerHTML = "";
    const cheapest = new Map();
    v.menu.forEach((b) => { const k = b.face + ":" + b.mode; if (!cheapest.has(k)) cheapest.set(k, b); });
    (game.dudo ? [0] : [0, 1]).forEach((mode) => {
      const row = document.createElement("div"); row.className = "mrow";
      const tag = document.createElement("span"); tag.className = "mtag lit";
      tag.textContent = game.dudo ? "" : (mode === 1 ? "斋" : "飞");
      tag.title = game.dudo ? "" : (mode === 1 ? "zhai: ones count as ones" : "fei: ones are wild");
      row.appendChild(tag);
      for (let f = 1; f <= 6; f++) {
        // Ones are always 斋: their cell sits in the 斋 row (the ship's single row holds the aces).
        const m = f === 1 ? 1 : mode;
        const b = (f === 1 && !game.dudo && mode === 0) ? null : cheapest.get(f + ":" + m);
        const btn = document.createElement("button"); btn.className = "cell";
        if (b) { btn.innerHTML = "<b>" + b.qty + "</b> × " + die(b.face); btn.addEventListener("click", () => answer(v.menu.indexOf(b))); }
        else { btn.innerHTML = "<b>–</b> × " + die(f); btn.disabled = true; }
        row.appendChild(btn);
      }
      menu.appendChild(row);
    });
    // The stepper: any legal raise.
    // The stepper opens where the device seats its builder: on a raise, the
    // cheapest legal one (it carries the round's mode); on an open, face 2 at
    // the 飞 floor. Ones and the ship force their own mode either way.
    game.pick = (v.standing && v.menu.length) ? { qty: v.menu[0].qty, face: v.menu[0].face, mode: v.menu[0].mode } : { qty: 1, face: 2, mode: 0 };
    snapQty();
    renderStepper();
    $("challenge").disabled = !v.standing;
    // The sweep on offer: a run of recent bidders behind the standing bid.
    const run = v.sweep || [];
    $("sweepWrap").hidden = run.length < 2;
    if (run.length >= 2) {
      const sel = $("sweepDepth"); sel.innerHTML = "";
      for (let d = 2; d <= run.length; d++) { const o = document.createElement("option"); o.value = d; o.textContent = d; sel.appendChild(o); }
      sel.value = "2";
      const who = () => run.slice(0, parseInt(sel.value, 10)).map((t) => seatName(t.seat) + " (" + bidText(t.bid) + ")").join(", ");
      $("sweepWho").textContent = who();
      sel.onchange = () => { $("sweepWho").textContent = who(); };
    }
    $("turnMsg").textContent = v.standing ? "" : openLine(v.menu);
    $("turn").hidden = false;
    $("turn").scrollIntoView({ block: "nearest" });
  }
  // The opening floors, read off the legal menu so they can never drift from
  // the engine: the bar scales them with the table, the ship opens on one.
  function openLine(menu) {
    const min = (pred) => menu.filter(pred).reduce((m, b) => Math.min(m, b.qty), Infinity);
    const any = min((b) => b.face !== 1), ones = min((b) => b.face === 1);
    if (game.dudo) return "You open: any face but ones, from " + any + ". Ones are wild.";
    return "You open: " + any + " or more of a face (飞, ones wild), or " + ones + " or more ones (斋, ones count as ones).";
  }
  function pickMode(p) { return p.face === 1 ? 1 : (game.dudo ? 0 : p.mode); }   // ones are always 斋; the ship is always 飞
  function legalIndex(p) { const m = pickMode(p); return game.view.menu.findIndex((b) => b.qty === p.qty && b.face === p.face && b.mode === m); }
  // Snap the quantity up to the cheapest legal raise on this face in this mode.
  function snapQty() {
    const p = game.pick, m = pickMode(p);
    const legal = game.view.menu.filter((b) => b.face === p.face && b.mode === m).map((b) => b.qty);
    if (legal.length && p.qty < Math.min.apply(null, legal)) p.qty = Math.min.apply(null, legal);
  }
  function renderStepper() {
    const p = game.pick;
    $("qty").value = p.qty;
    const faces = $("faces"); faces.innerHTML = "";
    for (let f = 1; f <= 6; f++) {
      const b = document.createElement("button"); b.className = "face" + (f === p.face ? " on" : ""); b.dataset.face = f; b.innerHTML = die(f);
      b.addEventListener("click", () => {
        // A face click lands on a bid you can press: the quantity snaps up to
        // that face's cheapest legal raise when what is typed is below it.
        game.pick.face = f;
        snapQty();
        renderStepper();
      });
      faces.appendChild(b);
    }
    // The mode key, bar only: ones are always 斋, so it goes quiet on that face.
    const mb = $("modeBtn"); mb.hidden = !!game.dudo;
    mb.disabled = p.face === 1;
    mb.textContent = pickMode(p) === 1 ? "斋 zhai" : "飞 fei";
    const ok = legalIndex(p) >= 0;
    $("bidTyped").disabled = !ok;
    $("bidTyped").textContent = ok ? "Bid " + p.qty + " × " + p.face + " " + (modeTag(game.view.menu[legalIndex(p)]) || { t: "" }).t : "Not a legal raise";
  }
  function answer(i) {
    if (!pending) return;
    const r = pending; pending = null;
    $("turn").hidden = true; game.turn = -1; game.last[0] = "";
    r(i);
  }
  function answerTyped() {
    const q = parseInt($("qty").value, 10);
    if (q > 0) game.pick.qty = q;
    const i = legalIndex(game.pick);
    if (i < 0) { renderStepper(); return; }
    answer(i);
  }

  function finishMatch(winner) {
    const rec = load(STORE.record, {});
    for (let s = 1; s < game.n; s++) {
      const h = game.names[s]; rec[h] = rec[h] || { w: 0, l: 0 };
      if (winner === 0) rec[h].w++; else rec[h].l++;
    }
    save(STORE.record, rec);
    let streak = load(STORE.record + ".streak", 0);
    streak = winner === 0 ? (streak > 0 ? streak + 1 : 1) : (streak < 0 ? streak - 1 : -1);
    save(STORE.record + ".streak", streak);
    if (game.iou) {
      const mk = load(STORE.markers, markersDefault());
      for (let s = 0; s < game.n; s++) if (game.markers[s] >= 0) mk[game.names[s]] = game.markers[s];
      save(STORE.markers, mk);
    }
    $("matchEnd").hidden = false;
    $("matchEnd").textContent = (winner === 0 ? "You take the table." : seatName(winner) + " takes the table.") + (game.iou && game.markers[0] === 0 ? " Your markers are gone - you owe the house nothing." : "");
    renderRead(); renderRecord();
    $("again").hidden = false;
  }

  async function play() {
    const dudo = format() === "dudo";
    const iou = dudo && $("iou").checked;
    const rows = rosterRows();
    const seatsRows = seatOrder.map((k) => rows.find((r) => keyOf(r) === k));   // the chairs, in turn order
    if (iou) seatsRows.sort((a, b) => (a.rid - b.rid) || (a.idx - b.idx));   // Sol, Lark, Cove first, guests after
    const names = ["You"].concat(seatsRows.map((r) => r.name));
    const n = names.length;
    const rules = rulesConfig();
    const skill = $("skillRoster").checked ? -1 : parseFloat($("skill").value);
    let seed = parseInt($("seed").value, 10);
    if (!(seed > 0)) seed = (Math.random() * 0x7fffffff) | 0;
    let cfg = "dudo=" + (dudo ? 1 : 0) + ";seats=" + seatsRows.map((r) => r.rid + ":" + r.idx).join(",") +
              ";skill=" + skill + ";mask=" + rules.mask + ";ck=" + rules.ck + ";seed=" + seed;
    const est = load(STORE.est, null);
    if (est && est.n) cfg += ";est=" + est.ct + "," + est.bc + "," + est.br + "," + est.n;
    const markers = new Array(n).fill(-1);
    if (iou) {
      const mk = load(STORE.markers, markersDefault());
      for (let s = 0; s < n; s++) if (names[s] in mk) markers[s] = mk[names[s]];
      const coll = names.map((h) => (h === "Sol" || h === "Lark") ? 1 : 0);
      cfg += ";iou=1;years=" + markers.join(",") + ";coll=" + coll.join(",");
    }
    queue = []; draining = false; onContinue = null; view = null; duelView = null; calzaView = null; pending = null;
    if (calzaTimer) { clearInterval(calzaTimer); calzaTimer = null; }
    game = { n, names, dudo, iou, dice: new Array(n).fill(dudo ? 5 : 0), alive: new Array(n).fill(true), last: new Array(n).fill(""),
             tol: [info.player.tolerance].concat(seatsRows.map((r) => r.tolerance)), markers,
             standing: null, bidder: -1, turn: -1, hand: 0, over: false, view: null, pick: null, stake: 1,
             log: ["# Liar's Dice " + (dudo ? "ship" : "bar") + " table, seed " + seed + ", build " + $("build").textContent,
                   "# cfg " + cfg, "# seats " + names.join(", ")] };
    $("setup").hidden = true; $("table").hidden = false; $("matchEnd").hidden = true; $("reveal").hidden = true; $("duel").hidden = true; $("calza").hidden = true; $("again").hidden = true;
    $("tableTitle").textContent = (dudo ? "The ship" : "The bar") + (iou ? " - IOU" : "");
    $("log").textContent = game.log.join("\n");
    renderSeats();
    try {
      await M.ccall("play_match", "number", ["string"], [cfg], { async: true });
    } catch (e) {
      log("! the table broke: " + e); $("again").hidden = false;
    }
  }

  function copyLog() {
    const text = game.log.join("\n");
    const done = () => { $("copyMsg").textContent = "copied"; setTimeout(() => { $("copyMsg").textContent = ""; }, 2000); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
    else fallbackCopy(text, done);
  }
  function fallbackCopy(text, done) {
    const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); done(); } catch (e) { $("copyMsg").textContent = "select the log and copy it"; }
    document.body.removeChild(ta);
  }

  // ---- boot -------------------------------------------------------------------------
  window.table = { decide, duel, interrupt, event: onEvent };
  fetch("dist/BUILD").then((r) => r.text()).then((t) => { $("build").textContent = t.trim(); }).catch(() => {});
  createTable().then((mod) => {
    M = mod;
    info = JSON.parse(M.ccall("table_info", "string"));
    renderRead(); renderRecord(); onFormat();
    document.querySelectorAll("input[name=format]").forEach((r) => r.addEventListener("change", onFormat));
    $("iou").addEventListener("change", () => renderRivals(false));
    $("skillRoster").addEventListener("change", () => { $("skill").disabled = $("skillRoster").checked; });
    $("skill").addEventListener("input", () => { $("skillv").textContent = parseFloat($("skill").value).toFixed(2); });
    $("play").addEventListener("click", play);
    $("bidTyped").addEventListener("click", answerTyped);
    $("qty").addEventListener("input", () => { const q = parseInt($("qty").value, 10); if (q > 0) { game.pick.qty = q; renderStepper(); } });
    $("qty").addEventListener("keydown", (e) => { if (e.key === "Enter") answerTyped(); });
    $("qtyUp").addEventListener("click", () => { game.pick.qty++; renderStepper(); });
    $("modeBtn").addEventListener("click", () => { game.pick.mode = game.pick.mode === 1 ? 0 : 1; snapQty(); renderStepper(); });
    $("qtyDown").addEventListener("click", () => { if (game.pick.qty > 1) game.pick.qty--; renderStepper(); });
    $("challenge").addEventListener("click", () => answer(-1));
    $("sweep").addEventListener("click", () => answer(-(parseInt($("sweepDepth").value, 10) + 1)));
    $("calzaYes").addEventListener("click", () => answerCalza(1));
    $("calzaChallenge").addEventListener("click", () => answerCalza(2));
    $("calzaNo").addEventListener("click", () => answerCalza(0));
    $("duelStand").addEventListener("click", () => answerDuel(0));
    $("duelEscalate").addEventListener("click", () => answerDuel(1));
    $("duelFold").addEventListener("click", () => answerDuel(2));
    $("copyLog").addEventListener("click", copyLog);
    const savedPace = load(STORE.pace, "normal");
    if (PACE[savedPace]) { $("pace").value = savedPace; pace = PACE[savedPace]; }
    $("pace").addEventListener("change", () => { pace = PACE[$("pace").value] || 1; save(STORE.pace, $("pace").value); });
    const savedWindow = load(STORE.window, null);
    if (typeof savedWindow === "number") { windowSec = savedWindow; $("window").value = savedWindow; }
    const showWindow = () => { $("windowv").textContent = windowSec <= 0 ? "off" : windowSec + "s"; };
    showWindow();
    $("window").addEventListener("input", () => { windowSec = parseFloat($("window").value); save(STORE.window, windowSec); showWindow(); });
    $("again").addEventListener("click", () => { $("table").hidden = true; $("setup").hidden = false; renderRivals(); });
    $("forget").addEventListener("click", (e) => { e.preventDefault(); localStorage.removeItem(STORE.est); localStorage.removeItem(STORE.record); localStorage.removeItem(STORE.record + ".streak"); renderRead(); renderRecord(); });
    $("resetMarkers").addEventListener("click", (e) => {
      e.preventDefault(); localStorage.removeItem(STORE.markers);
      const d = markersDefault();
      $("resetMsg").textContent = "(back to the house's opening book: " + Object.keys(d).map((k) => k + " " + d[k]).join(", ") + ")";
    });
    // The report link is an in-page anchor; on a short page nothing scrolls, so flash the panel too.
    $("toReport").addEventListener("click", () => {
      const p = $("reporting"); p.scrollIntoView({ behavior: "smooth", block: "start" });
      p.classList.remove("flash"); void p.offsetWidth; p.classList.add("flash");
    });
  }).catch((e) => { $("readline").textContent = "The table failed to load: " + e; });
})();
