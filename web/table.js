// web/table.js - the browser table over dist/table.js (the host sim in wasm).
// Contract with tools/web/bridge.cpp: window.table.decide(view) -> Promise<int>,
// window.table.event(ev); Module.ccall("table_info"), Module.ccall("play_match").
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const DIE = ["", "⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];
  const STORE = { est: "ld.estimate", record: "ld.record", markers: "ld.markers" };

  let M = null;        // the wasm module
  let info = null;     // table_info()
  let game = null;     // the live match's state
  let pending = null;  // the resolve of the decision the page owes the engine

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
    $("record").textContent = parts.length ? "Record: " + parts.join(" · ") + (streak ? " · streak " + (streak > 0 ? "W" : "L") + Math.abs(streak) : "") : "";
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

  // ---- the match --------------------------------------------------------------------
  function seatName(s) { return game.names[s]; }
  function bidText(b) { return b.qty + " × " + DIE[b.face] + (b.mode === 1 ? " (ones literal)" : ""); }
  function log(line) { game.log.push(line); $("log").textContent = game.log.join("\n"); $("log").scrollTop = 1e9; }

  function renderSeats() {
    const box = $("seatsView"); box.innerHTML = "";
    for (let s = 0; s < game.n; s++) {
      const d = document.createElement("div");
      d.className = "seat" + (s === 0 ? " you" : "") + (s === game.turn ? " turn" : "") + (game.alive[s] ? "" : " out");
      const stat = game.dudo ? (game.dice[s] + " dice") : (game.dice[s] + " drinks / " + game.tol[s]);
      const mk = game.iou && game.markers[s] >= 0 ? "<div class='stat'>markers " + game.markers[s] + "</div>" : "";
      d.innerHTML = "<div class='name'>" + seatName(s) + "</div><div class='stat'>" + stat + "</div>" + mk;
      box.appendChild(d);
    }
    $("standing").textContent = game.standing ? "Standing: " + bidText(game.standing) + " by " + seatName(game.bidder) : (game.over ? "" : "No bid yet - hand " + (game.hand + 1));
  }

  function onEvent(ev) {
    if (ev.dice) { game.dice = ev.dice.slice(); }
    switch (ev.kind) {
      case "HandStart":
        game.hand = ev.hand; game.standing = null; game.bidder = -1; game.turn = ev.seat;
        $("reveal").hidden = true;
        log("H" + (ev.hand + 1) + " deal, " + seatName(ev.seat) + " opens" + (game.dudo ? "  dice " + ev.dice.join("/") : "  drinks " + ev.dice.join("/")));
        break;
      case "Bid":
        game.standing = ev.bid; game.bidder = ev.seat; game.turn = -1;
        log("  " + seatName(ev.seat) + " bids " + bidText(ev.bid));
        break;
      case "Challenge":
        game.turn = -1;
        log("  " + seatName(ev.seat) + " challenges " + seatName(ev.other));
        break;
      case "Calza":
        log("  " + seatName(ev.seat) + " calls it exact" + (ev.count > 0 ? " - and it is (+1 die)" : " - it is not (-1 die)"));
        break;
      case "Reveal": {
        const box = $("reveal"); box.hidden = false;
        const cups = ev.hands.map((h, s) => "<div>" + seatName(s) + ": <span class='cup'>" + h.map((d) => DIE[d]).join("") + "</span></div>").join("");
        box.innerHTML = "<div>Reveal: " + bidText(ev.bid) + " - " + ev.count + " on the table. " + seatName(ev.seat) + " pays.</div><div class='cups'>" + cups + "</div>";
        log("  reveal: " + ev.count + " × " + DIE[ev.bid.face] + " on the table; " + seatName(ev.seat) + " loses");
        break;
      }
      case "Surrender":
        log("  " + seatName(ev.seat) + " folds the challenge (no reveal)");
        break;
      case "Penalty":
        log("  " + seatName(ev.seat) + " pays " + ev.count + (game.dudo ? " die" : " drink") + (Math.abs(ev.count) === 1 ? "" : "s"));
        break;
      case "KnockOut":
        game.alive[ev.seat] = false;
        log("  " + seatName(ev.seat) + " is out" + (ev.other >= 0 ? " (" + seatName(ev.other) + ")" : ""));
        break;
      case "Ledger":
        if (game.markers[ev.seat] >= 0) game.markers[ev.seat] = Math.max(0, game.markers[ev.seat] + ev.count);
        log("  " + seatName(ev.seat) + (ev.count < 0 ? " shreds " + (-ev.count) : " takes on " + ev.count) + " marker" + (Math.abs(ev.count) === 1 ? "" : "s"));
        break;
      case "MatchEnd":
        game.over = true; game.turn = -1; game.winner = ev.seat;
        log("Match over after " + ev.count + " hands: " + seatName(ev.seat) + " is the last cup standing.");
        break;
      case "Estimate":
        save(STORE.est, { ct: ev.ct, bc: ev.bc, br: ev.br, n: ev.n });
        finishMatch(ev.winner);
        break;
    }
    renderSeats();
  }

  function decide(view) {
    game.turn = 0; game.view = view;
    renderSeats();
    $("cup").textContent = view.hand.map((d) => DIE[d]).join("");
    $("unknown").textContent = view.unknown + " dice you can't see";
    const menu = $("menu"); menu.innerHTML = "";
    view.menu.forEach((b, i) => {
      const btn = document.createElement("button"); btn.textContent = bidText(b);
      btn.addEventListener("click", () => answer(i));
      menu.appendChild(btn);
    });
    $("challenge").disabled = !view.standing;
    $("turnMsg").textContent = view.standing ? "" : "You open.";
    $("qty").value = view.menu.length ? view.menu[0].qty : "";
    $("face").value = view.menu.length ? view.menu[0].face : "2";
    $("turn").hidden = false;
    $("turn").scrollIntoView({ block: "nearest" });
    return new Promise((resolve) => { pending = resolve; });
  }
  function answer(i) {
    if (!pending) return;
    const r = pending; pending = null;
    $("turn").hidden = true; game.turn = -1;
    r(i);
  }
  function answerTyped() {
    const q = parseInt($("qty").value, 10), f = parseInt($("face").value, 10);
    const i = game.view.menu.findIndex((b) => b.qty === q && b.face === f);
    if (i < 0) { $("turnMsg").textContent = q + " × " + DIE[f] + " is not a legal raise here."; return; }
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
    game = { n, names, dudo, iou, dice: new Array(n).fill(dudo ? 5 : 0), alive: new Array(n).fill(true),
             tol: [info.player.tolerance].concat(seatsRows.map((r) => r.tolerance)), markers,
             standing: null, bidder: -1, turn: -1, hand: 0, over: false, view: null,
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
    $("qty").addEventListener("keydown", (e) => { if (e.key === "Enter") answerTyped(); });
    $("challenge").addEventListener("click", () => answer(-1));
    $("copyLog").addEventListener("click", copyLog);
    $("again").addEventListener("click", () => { $("table").hidden = true; $("setup").hidden = false; renderRivals(); });
    $("forget").addEventListener("click", (e) => { e.preventDefault(); localStorage.removeItem(STORE.est); localStorage.removeItem(STORE.record); localStorage.removeItem(STORE.record + ".streak"); renderRead(); renderRecord(); });
    $("resetMarkers").addEventListener("click", (e) => { e.preventDefault(); localStorage.removeItem(STORE.markers); });
  }).catch((e) => { $("readline").textContent = "The table failed to load: " + e; });
})();
