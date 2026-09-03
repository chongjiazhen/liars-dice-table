// web/table.js - the browser table over dist/table.js (the host sim in wasm).
// Contract with tools/web/bridge.cpp: window.table.decide(view) -> Promise<int>,
// window.table.event(ev); Module.ccall("table_info"), Module.ccall("play_match").
//
// Events arrive synchronously from inside the wasm run, so the page queues them
// and renders the queue on a timer: each AI action gets a beat, a reveal waits
// for a click, and your turn panel opens only once the queue has drained. The
// engine is blocked in the decider meanwhile (Asyncify), so nothing is lost.
// `?fast=1` drops every delay and auto-continues reveals (the drive.js gate).
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const STORE = { est: "ld.estimate", record: "ld.record", markers: "ld.markers" };
  const FAST = /[?&]fast=1/.test(location.search);
  const BEAT = FAST ? 0 : 550;          // ms per AI action
  const HAND_BEAT = FAST ? 0 : 900;     // ms on a new deal

  let M = null;        // the wasm module
  let info = null;     // table_info()
  let game = null;     // the live match's state
  let pending = null;  // the resolve of the decision the page owes the engine
  let view = null;     // the decision view waiting to be shown
  let queue = [];      // events not yet rendered
  let draining = false;
  let onContinue = null;   // a reveal waiting for its click

  // ---- dice ---------------------------------------------------------------------
  const PIPS = { 1: [[1, 1]], 2: [[0, 0], [2, 2]], 3: [[0, 0], [1, 1], [2, 2]],
                 4: [[0, 0], [0, 2], [2, 0], [2, 2]], 5: [[0, 0], [0, 2], [1, 1], [2, 0], [2, 2]],
                 6: [[0, 0], [0, 1], [0, 2], [2, 0], [2, 1], [2, 2]] };
  function die(n, cls) {
    const pips = (PIPS[n] || []).map(([x, y]) => "<circle cx='" + (5 + x * 6) + "' cy='" + (5 + y * 6) + "' r='1.7'/>").join("");
    return "<svg class='die" + (cls ? " " + cls : "") + (n === 1 ? " one" : "") + "' viewBox='0 0 22 22' aria-label='" + n + "'><rect x='1' y='1' width='20' height='20' rx='4'/>" + pips + "</svg>";
  }
  function cupHtml(hand) { return hand.map((d) => die(d)).join(""); }
  function bidHtml(b) { return "<b>" + b.qty + "</b> × " + die(b.face) + (b.mode === 1 ? " <span class='lit'>1s literal</span>" : ""); }
  function bidText(b) { return b.qty + " × " + b.face + (b.mode === 1 ? " (ones literal)" : ""); }

  // ---- storage ---------------------------------------------------------------
  function load(key, dflt) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : dflt; } catch (e) { return dflt; } }
  function save(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* private mode */ } }
  function markersDefault() { return { You: 40, Sol: 100, Lark: 12 }; }

  // ---- the read line -----------------------------------------------------------
  function readLine() {
    const e = load(STORE.est, null);
    if (!e || !e.n) return "The table hasn't met you yet.";
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
    // host cast first, the other cast after
    const bar = info.bar.map((r, i) => Object.assign({ rid: 1, idx: i }, r));
    const ship = info.ship.map((r, i) => Object.assign({ rid: 0, idx: i }, r));
    return format() === "dudo" ? ship.concat(bar) : bar.concat(ship);
  }
  function renderRivals(fresh) {
    const rows = rosterRows();
    const want = parseInt($("seats").value, 10) - 1;
    const iou = $("iou").checked && format() === "dudo";
    const prior = new Set(fresh ? [] : Array.from(document.querySelectorAll("#rivals input:checked")).map((i) => i.value));
    const box = $("rivals"); box.innerHTML = "";
    let picked = 0;
    rows.forEach((r, k) => {
      const key = r.rid + ":" + r.idx;
      const forced = iou && r.rid === 0;                       // the crew and the house sit in IOU mode
      let on = forced || (prior.size ? prior.has(key) : k < want);
      if (!forced && on && picked >= want) on = false;
      if (on) picked++;
      const l = document.createElement("label");
      const c = document.createElement("input"); c.type = "checkbox"; c.value = key; c.checked = on; c.disabled = forced;
      c.addEventListener("change", enforceCount);
      l.appendChild(c); l.appendChild(document.createTextNode(" " + r.name + " "));
      const s = document.createElement("span"); s.className = "hint"; s.textContent = r.rid === 0 ? "ship" : "bar"; l.appendChild(s);
      box.appendChild(l);
    });
    enforceCount();
  }
  function enforceCount() {
    const want = parseInt($("seats").value, 10) - 1;
    const boxes = Array.from(document.querySelectorAll("#rivals input"));
    const on = boxes.filter((b) => b.checked).length;
    boxes.forEach((b) => { if (!b.checked) b.disabled = on >= want; });
    $("play").disabled = on !== want;
    $("play").textContent = on === want ? "Deal" : "Pick " + (want - on) + " more";
  }
  function renderRules() {
    const box = $("rules"); box.innerHTML = "";
    const home = format() === "dudo" ? "ship" : "bar";
    info.rules.forEach((r) => {
      const l = document.createElement("label");
      const c = document.createElement("input"); c.type = "checkbox"; c.value = r.id; c.checked = r.biome === home;
      c.addEventListener("change", rulesSummary);
      l.appendChild(c); l.appendChild(document.createTextNode(" " + r.name + " "));
      const s = document.createElement("span"); s.className = "hint"; s.textContent = r.biome === home ? "house" : (r.portable ? r.biome : r.biome + ", stays home"); l.appendChild(s);
      if (!r.portable && r.biome !== home) c.disabled = true;
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
    if ($("iou").checked && parseInt($("seats").value, 10) < 4) $("seats").value = "4";
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
      const stat = game.dudo ? (game.dice[s] + (game.dice[s] === 1 ? " die" : " dice")) : (game.dice[s] + " / " + game.tol[s] + " drinks");
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
    let wait = BEAT;
    switch (ev.kind) {
      case "HandStart":
        game.hand = ev.hand; game.standing = null; game.bidder = -1; game.turn = ev.seat;
        game.last = game.last.map((_, s) => (game.alive[s] ? "" : "out"));
        $("reveal").hidden = true;
        log("H" + (ev.hand + 1) + " deal, " + seatName(ev.seat) + " opens" + (game.dudo ? "  dice " + ev.dice.join("/") : "  drinks " + ev.dice.join("/")));
        wait = HAND_BEAT;
        break;
      case "Bid":
        game.standing = ev.bid; game.bidder = ev.seat; game.turn = (ev.seat + 1) % game.n;
        while (!game.alive[game.turn]) game.turn = (game.turn + 1) % game.n;
        game.last[ev.seat] = "bid " + bidHtml(ev.bid);
        log("  " + seatName(ev.seat) + " bids " + bidText(ev.bid));
        break;
      case "Challenge":
        game.turn = -1;
        game.last[ev.seat] = "<span class='act'>challenges " + seatName(ev.other) + "</span>";
        log("  " + seatName(ev.seat) + " challenges " + seatName(ev.other));
        break;
      case "Calza":
        game.turn = -1; game.calza = ev.count > 0;
        game.last[ev.seat] = "<span class='act'>calls it exact</span>";
        log("  " + seatName(ev.seat) + " calls it exact" + (ev.count > 0 ? " - and it is (+1 die)" : " - it is not (-1 die)"));
        break;
      case "Reveal": {
        const box = $("reveal"); box.hidden = false;
        const cups = ev.hands.map((h, s) => h.length ? "<div class='cupline'><span class='who'>" + seatName(s) + "</span> <span class='cup'>" + cupHtml(h) + "</span></div>" : "").join("");
        const exact = game.calza !== undefined;
        const verdict = exact
          ? (game.calza ? seatName(ev.seat) + " called it exactly right." : seatName(ev.seat) + " called exact and missed.")
          : seatName(ev.seat) + " loses the hand.";
        box.innerHTML = "<div class='verdict'>" + bidHtml(ev.bid) + " · <b>" + ev.count + "</b> on the table. " + verdict + "</div><div class='cups'>" + cups + "</div>" +
                        (FAST ? "" : "<button id='continue' class='primary'>Continue</button>");
        delete game.calza;
        log("  reveal: " + ev.count + " × " + ev.bid.face + " on the table; " + seatName(ev.seat) + (exact ? " called exact" : " loses"));
        if (!FAST) { wait = -1; $("continue").addEventListener("click", () => { $("continue").disabled = true; const c = onContinue; onContinue = null; if (c) c(); }); }
        break;
      }
      case "Surrender":
        game.last[ev.seat] = "<span class='act'>folds</span>";
        log("  " + seatName(ev.seat) + " folds the challenge (no reveal)");
        break;
      case "Penalty":
        game.last[ev.seat] = "pays " + ev.count + (game.dudo ? (Math.abs(ev.count) === 1 ? " die" : " dice") : (Math.abs(ev.count) === 1 ? " drink" : " drinks"));
        log("  " + seatName(ev.seat) + " pays " + ev.count + (game.dudo ? " die" : " drink") + (Math.abs(ev.count) === 1 ? "" : "s"));
        break;
      case "KnockOut":
        game.alive[ev.seat] = false; game.last[ev.seat] = "<span class='act'>out</span>";
        log("  " + seatName(ev.seat) + " is out" + (ev.other >= 0 ? " (" + seatName(ev.other) + ")" : ""));
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
    if (!queue.length) { showTurn(); return; }
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
  function showTurn() {
    if (!view || !pending) return;
    const v = view; view = null;
    game.turn = 0; game.view = v;
    renderSeats();
    $("cup").innerHTML = cupHtml(v.hand);
    $("unknown").textContent = v.unknown + " dice you can't see";
    // Suggested raises: the cheapest legal raise on each face (and each mode),
    // lowest first - one row of buttons, the stepper covers the rest.
    const menu = $("menu"); menu.innerHTML = "";
    const cheapest = new Map();
    v.menu.forEach((b) => { const k = b.face + ":" + b.mode; if (!cheapest.has(k)) cheapest.set(k, b); });
    const picks = Array.from(cheapest.values()).sort((a, b) => a.qty - b.qty || a.face - b.face).slice(0, 8);
    picks.forEach((b) => {
      const btn = document.createElement("button"); btn.innerHTML = bidHtml(b);
      btn.addEventListener("click", () => answer(v.menu.indexOf(b)));
      menu.appendChild(btn);
    });
    // The stepper: any legal raise.
    game.pick = v.menu.length ? { qty: v.menu[0].qty, face: v.menu[0].face, mode: v.menu[0].mode } : { qty: 1, face: 2, mode: 0 };
    $("literalWrap").hidden = !v.menu.some((b) => b.mode === 1);
    renderStepper();
    $("challenge").disabled = !v.standing;
    $("turnMsg").textContent = v.standing ? "" : "You open.";
    $("turn").hidden = false;
    $("turn").scrollIntoView({ block: "nearest" });
  }
  function legalIndex(p) { return game.view.menu.findIndex((b) => b.qty === p.qty && b.face === p.face && b.mode === p.mode); }
  function renderStepper() {
    const p = game.pick;
    $("qty").value = p.qty;
    const faces = $("faces"); faces.innerHTML = "";
    for (let f = 1; f <= 6; f++) {
      const b = document.createElement("button"); b.className = "face" + (f === p.face ? " on" : ""); b.dataset.face = f; b.innerHTML = die(f);
      b.addEventListener("click", () => { game.pick.face = f; renderStepper(); });
      faces.appendChild(b);
    }
    $("literal").checked = p.mode === 1;
    const ok = legalIndex(p) >= 0;
    $("bidTyped").disabled = !ok;
    $("bidTyped").textContent = ok ? "Bid " + p.qty + " × " + p.face : "Not a legal raise";
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
    const picks = Array.from(document.querySelectorAll("#rivals input:checked")).map((c) => c.value);
    const rows = rosterRows();
    const seatsRows = picks.map((k) => rows.find((r) => r.rid + ":" + r.idx === k));
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
    queue = []; draining = false; onContinue = null; view = null; pending = null;
    game = { n, names, dudo, iou, dice: new Array(n).fill(dudo ? 5 : 0), alive: new Array(n).fill(true), last: new Array(n).fill(""),
             tol: [info.player.tolerance].concat(seatsRows.map((r) => r.tolerance)), markers,
             standing: null, bidder: -1, turn: -1, hand: 0, over: false, view: null, pick: null,
             log: ["# Liar's Dice " + (dudo ? "ship" : "bar") + " table, seed " + seed + ", build " + $("build").textContent,
                   "# cfg " + cfg, "# seats " + names.join(", ")] };
    $("setup").hidden = true; $("table").hidden = false; $("matchEnd").hidden = true; $("reveal").hidden = true; $("again").hidden = true;
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
  window.table = { decide, event: onEvent };
  fetch("dist/BUILD").then((r) => r.text()).then((t) => { $("build").textContent = t.trim(); }).catch(() => {});
  createTable().then((mod) => {
    M = mod;
    info = JSON.parse(M.ccall("table_info", "string"));
    renderRead(); renderRecord(); onFormat();
    document.querySelectorAll("input[name=format]").forEach((r) => r.addEventListener("change", onFormat));
    $("seats").addEventListener("change", () => { if ($("iou").checked && parseInt($("seats").value, 10) < 4) $("seats").value = "4"; renderRivals(); });
    $("iou").addEventListener("change", onFormat);
    $("skillRoster").addEventListener("change", () => { $("skill").disabled = $("skillRoster").checked; });
    $("skill").addEventListener("input", () => { $("skillv").textContent = parseFloat($("skill").value).toFixed(2); });
    $("play").addEventListener("click", play);
    $("bidTyped").addEventListener("click", answerTyped);
    $("qty").addEventListener("input", () => { const q = parseInt($("qty").value, 10); if (q > 0) { game.pick.qty = q; renderStepper(); } });
    $("qty").addEventListener("keydown", (e) => { if (e.key === "Enter") answerTyped(); });
    $("qtyUp").addEventListener("click", () => { game.pick.qty++; renderStepper(); });
    $("qtyDown").addEventListener("click", () => { if (game.pick.qty > 1) game.pick.qty--; renderStepper(); });
    $("literal").addEventListener("change", () => { game.pick.mode = $("literal").checked ? 1 : 0; renderStepper(); });
    $("challenge").addEventListener("click", () => answer(-1));
    $("copyLog").addEventListener("click", copyLog);
    $("again").addEventListener("click", () => { $("table").hidden = true; $("setup").hidden = false; renderRivals(); });
    $("forget").addEventListener("click", (e) => { e.preventDefault(); localStorage.removeItem(STORE.est); localStorage.removeItem(STORE.record); localStorage.removeItem(STORE.record + ".streak"); renderRead(); renderRecord(); });
    $("resetMarkers").addEventListener("click", (e) => { e.preventDefault(); localStorage.removeItem(STORE.markers); });
  }).catch((e) => { $("readline").textContent = "The table failed to load: " + e; });
})();
