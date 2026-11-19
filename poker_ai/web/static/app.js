// RiverMind Poker browser client. The server owns the game; this file only
// renders the seat's view and sends {type, action, seq} messages over one
// WebSocket. The table id and seat token are kept in localStorage so a
// reload or dropped connection rejoins the same seat.

const STORAGE_KEY = "rivermind.seat";
const EVENT_DELAY_MS = 450;
const RANKS = { 10: "10", 11: "J", 12: "Q", 13: "K", 14: "A" };
const SUITS = { spades: "♠", hearts: "♥", diamonds: "♦", clubs: "♣" };
const POSITIONS = { small_blind: "SB", big_blind: "BB", button: "D" };
const STAGES = {
  pre_flop: "Pre-flop", flop: "Flop", turn: "Turn", river: "River",
  show_down: "Showdown", terminal: "Hand over",
};
const OPPONENT_INFO = {
  random: ["Random bots", "Pick any legal action uniformly."],
  checkpoint: ["RiverMind bots", "Play the trained checkpoint this server loaded."],
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

const app = {
  ws: null,
  seat: null, // {table_id, token}
  view: null,
  pending: false,
  retries: 0,
  shownEvents: 0,
  hand: null,
  leaving: false,
};

// Storage (may be unavailable in private windows) --------------------------

function loadSeat() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch { return null; }
}
function saveSeat(seat) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(seat)); } catch { /* ignore */ }
}
function clearSeat() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

// Connection ---------------------------------------------------------------

function setStatus(state) { $("#status").dataset.state = state; }

function connect() {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${scheme}://${location.host}/ws`);
  app.ws = ws;
  setStatus("connecting");
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "join", ...app.seat }));
  };
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "view") {
      app.retries = 0;
      setStatus("open");
      app.pending = false;
      render(message.view);
    } else if (message.type === "error") {
      app.pending = false;
      if (message.code === "unknown_table" || message.code === "unknown_seat") {
        clearSeat();
        app.seat = null;
        showLobby("That table has closed. Start a new one.");
        return;
      }
      toast(message.message);
      if (message.view) render(message.view);
    }
  };
  ws.onclose = () => {
    if (app.ws !== ws) return;
    setStatus("closed");
    app.pending = false;
    if (app.seat && !app.leaving) {
      const delay = Math.min(1000 * 2 ** app.retries, 8000);
      app.retries += 1;
      setTimeout(() => { if (app.seat && app.ws === ws) connect(); }, delay);
      if (app.view) renderControls(app.view);
    }
  };
}

function send(message) {
  if (!app.ws || app.ws.readyState !== WebSocket.OPEN || app.pending) return;
  app.pending = true;
  app.ws.send(JSON.stringify(message));
  if (app.view) renderControls(app.view);
}

// Lobby ----------------------------------------------------------------------

async function showLobby(message = "") {
  app.view = null;
  $("#table").hidden = true;
  $("#lobby").hidden = false;
  $("#balance").hidden = true;
  $("#lobby-message").textContent = message;
  setStatus("idle");
  const choices = $("#opponent-choices");
  choices.replaceChildren();
  let opponents = ["random"];
  try {
    opponents = (await (await fetch("/api/config")).json()).opponents;
  } catch { /* fall back to random */ }
  opponents.forEach((kind, i) => {
    const [title, detail] = OPPONENT_INFO[kind] || [kind, ""];
    const label = el("label");
    const input = el("input");
    input.type = "radio";
    input.name = "opponents";
    input.value = kind;
    input.checked = i === opponents.length - 1;
    const text = el("span", "", title);
    text.append(el("small", "", detail));
    label.append(input, text);
    choices.append(label);
  });
}

async function startTable() {
  const choice = document.querySelector('input[name="opponents"]:checked');
  $("#start").disabled = true;
  try {
    const response = await fetch("/api/tables", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ opponents: choice ? choice.value : "random" }),
    });
    if (!response.ok) throw new Error((await response.json()).detail || response.statusText);
    app.seat = await response.json();
    saveSeat(app.seat);
    openTable();
  } catch (err) {
    $("#lobby-message").textContent = `Could not start a table: ${err.message}`;
  } finally {
    $("#start").disabled = false;
  }
}

function openTable() {
  app.leaving = false;
  app.hand = null;
  app.shownEvents = 0;
  $("#lobby").hidden = true;
  $("#table").hidden = false;
  connect();
}

function leaveTable() {
  app.leaving = true;
  clearSeat();
  app.seat = null;
  if (app.ws) app.ws.close();
  app.ws = null;
  showLobby();
}

// Rendering ------------------------------------------------------------------

function cardNode(card) {
  if (card === null) return el("div", "card back", "");
  if (card === undefined) return el("div", "card slot", "");
  const node = el("div", `card ${card.suit === "hearts" || card.suit === "diamonds" ? "red" : ""}`);
  node.setAttribute("aria-label", `${RANKS[card.rank] || card.rank} of ${card.suit}`);
  node.append(document.createTextNode(RANKS[card.rank] || card.rank));
  node.append(el("span", "suit", SUITS[card.suit] || "?"));
  return node;
}

// "checks", "calls 100", "bets 100", "raises 200"; `you` gives the
// second-person form ("check", "call 100").
function describe(event, you = false) {
  let verb;
  let chips = event.chips;
  if (event.action === "fold") { verb = "fold"; chips = 0; }
  else if (event.action === "call") verb = event.facing ? "call" : "check";
  // Pre-flop the big blind is the opening bet, so any raise is a raise.
  else verb = event.facing || event.stage === "pre_flop" ? "raise" : "bet";
  const word = (v) => (you ? v : `${v}s`);
  if (verb === "raise" && event.facing) {
    // Fixed-limit raise: the call plus one bet, e.g. "calls 150 and raises 100".
    return `${word("call")} ${event.facing} and ${word("raise")} ${chips - event.facing}`;
  }
  return chips ? `${word(verb)} ${chips}` : word(verb);
}

function lastActions(view) {
  const last = {};
  for (const event of view.events) {
    if (event.stage === view.stage || event.action === "fold") last[event.seat] = event;
  }
  return last;
}

function renderSeat(view, seat, last) {
  const node = document.querySelector(`.seat[data-seat="${seat.seat}"]`);
  const payout = view.result ? view.result.payouts[seat.seat] : null;
  node.classList.toggle("turn", seat.is_turn);
  node.classList.toggle("folded", seat.folded);
  node.classList.toggle("winner", payout > 0);

  const head = el("div", "seat-head");
  head.append(el("span", "seat-name", seat.name));
  const badge = el("span", `badge ${seat.position}`, POSITIONS[seat.position]);
  badge.title = seat.position.replace("_", " ");
  head.append(badge);

  const cards = el("div", "cards");
  const shown = seat.cards || [null, null];
  shown.forEach((card) => cards.append(cardNode(card)));

  const chips = el("div", "seat-chips");
  chips.append(el("span", "", `Stack ${seat.stack}`));
  chips.append(el("span", "bet", seat.bet ? `In ${seat.bet}` : ""));

  const action = el("div", "last-action");
  if (payout !== null && payout !== undefined) {
    action.className = `payout ${payout > 0 ? "up" : payout < 0 ? "down" : ""}`;
    action.textContent = payout > 0 ? `+${payout}` : `${payout}`;
  } else if (seat.folded) {
    action.textContent = "Folded";
  } else if (last[seat.seat]) {
    action.textContent = describe(last[seat.seat]).replace(/^./, (c) => c.toUpperCase());
    const previous = node.dataset.last;
    const key = `${view.hand}:${view.events.indexOf(last[seat.seat])}`;
    if (previous && previous !== key && seat.kind === "bot") action.classList.add("flash");
    node.dataset.last = key;
  }
  node.replaceChildren(head, cards, chips, action);
}

function renderControls(view) {
  const controls = $("#controls");
  controls.replaceChildren();
  const connected = app.ws && app.ws.readyState === WebSocket.OPEN;
  if (view.result) {
    const next = el("button", "next", "Next hand");
    next.disabled = app.pending || !connected;
    next.onclick = () => send({ type: "next_hand", seq: view.seq });
    controls.append(next);
    return;
  }
  if (!view.your_turn) {
    controls.append(el("div", "waiting", connected ? "Waiting for the bots…" : "Reconnecting…"));
    return;
  }
  const amounts = view.action_amounts || {};
  for (const action of view.legal_actions) {
    let label = "Fold";
    if (action === "call") label = amounts.call ? `Call ${amounts.call}` : "Check";
    if (action === "raise") label = `${amounts.call ? "Raise" : "Bet"} ${amounts.raise}`;
    const button = el("button", action, label);
    button.disabled = app.pending || !connected;
    button.onclick = () => send({ type: "act", action, seq: view.seq });
    controls.append(button);
  }
}

function renderResult(view) {
  const node = $("#result");
  if (!view.result) { node.hidden = true; return; }
  const winners = view.seats.filter((s) => view.result.payouts[s.seat] > 0);
  const names = winners.map((s) => (s.seat === view.seat ? "You" : s.name));
  const amount = winners.length ? view.result.payouts[winners[0].seat] : 0;
  const plural = names.length > 1 || names[0] === "You";
  const each = names.length > 1 ? " each" : "";
  const where = view.result.showdown ? " at showdown" : "";
  node.textContent = `${names.join(" and ")} ${plural ? "win" : "wins"} ${amount}${each}${where}`;
  node.hidden = false;
}

function renderLog(view) {
  const log = $("#log");
  if (app.hand !== view.hand) {
    app.hand = view.hand;
    app.shownEvents = 0;
    log.replaceChildren();
    addLogLine(`Hand ${view.hand}`, "street", 0);
  }
  if (view.events.length < app.shownEvents) app.shownEvents = 0;
  const names = Object.fromEntries(view.seats.map((s) => [s.seat, s.seat === view.seat ? "You" : s.name]));
  let stage = app.shownEvents ? view.events[app.shownEvents - 1].stage : "pre_flop";
  let delay = 0;
  for (const event of view.events.slice(app.shownEvents)) {
    if (event.stage !== stage) {
      stage = event.stage;
      addLogLine(STAGES[stage] || stage, "street", delay);
    }
    const mine = event.seat === view.seat;
    addLogLine(`${names[event.seat]} ${describe(event, mine)}`, mine ? "mine" : "", delay);
    if (!mine) delay += EVENT_DELAY_MS;
  }
  app.shownEvents = view.events.length;
  if (view.result) {
    const lines = view.seats.map((s) => {
      const p = view.result.payouts[s.seat];
      return `${names[s.seat]} ${p > 0 ? "+" : ""}${p}`;
    });
    addLogLine(lines.join(" · "), "street", delay);
  }
}

function addLogLine(text, cls, delay) {
  const log = $("#log");
  const item = el("li", cls, text);
  log.append(item);
  setTimeout(() => {
    item.classList.add("shown");
    log.scrollTop = log.scrollHeight;
  }, delay);
}

function render(view) {
  app.view = view;
  const last = lastActions(view);
  view.seats.forEach((seat) => renderSeat(view, seat, last));
  $("#stage").textContent = STAGES[view.stage] || view.stage;
  const board = $("#board");
  board.replaceChildren();
  for (let i = 0; i < 5; i += 1) board.append(cardNode(view.board[i]));
  $("#pot").textContent = `Pot ${view.pot}`;
  renderResult(view);
  renderControls(view);
  renderLog(view);
  const me = view.seats[view.seat];
  const balance = $("#balance");
  balance.hidden = false;
  balance.textContent = `Session ${me.balance > 0 ? "+" : ""}${me.balance}`;
  balance.className = `balance ${me.balance > 0 ? "up" : me.balance < 0 ? "down" : ""}`;
}

let toastTimer;
function toast(text) {
  const node = $("#toast");
  node.textContent = text;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 3500);
}

// Boot -------------------------------------------------------------------------

$("#start").addEventListener("click", startTable);
$("#leave").addEventListener("click", leaveTable);
const saved = loadSeat();
if (saved && saved.table_id && saved.token) {
  app.seat = saved;
  openTable();
} else {
  showLobby();
}
