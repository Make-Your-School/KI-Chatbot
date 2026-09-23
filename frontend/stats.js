// Statistics page.
//
// Reads /api/stats and renders it. There is nothing per-person to show here —
// the server only keeps daily counters — so this file has no notion of users,
// sessions or history.

const $ = (id) => document.getElementById(id);

const loginView = $("login");
const statsView = $("stats");
const loginForm = $("login-form");
const codeInput = $("code-input");
const loginError = $("login-error");
const statsBody = $("stats-body");
const reloadBtn = $("reload-btn");
const logoutBtn = $("logout-btn");

const showView = (name) => {
  loginView.hidden = name !== "login";
  statsView.hidden = name !== "stats";
  if (name === "login") codeInput.focus();
};

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const nf = new Intl.NumberFormat("de-DE");

const RANGE_LABELS = [
  ["today", "Heute"],
  ["week", "7 Tage"],
  ["month", "Dieser Monat"],
  ["year", "Dieses Jahr"],
];

const ROW_LABELS = [
  ["chat", "Chat-Anfragen"],
  ["ragHit", "davon mit Treffer im Wissen"],
  ["ragMiss", "davon ohne Treffer"],
  ["loginOk", "Logins erfolgreich"],
  ["loginFail", "Logins fehlgeschlagen"],
  ["rateLimited", "Limit erreicht"],
  ["chatError", "Fehler bei der Antwort"],
];

const makeTable = (data) => {
  const table = el("table", "stats-table");

  const head = el("tr");
  head.appendChild(el("th", null, ""));
  for (const [, label] of RANGE_LABELS) head.appendChild(el("th", null, label));
  table.appendChild(head);

  for (const [field, label] of ROW_LABELS) {
    const row = el("tr");
    row.appendChild(el("th", "stats-rowlabel", label));
    for (const [range] of RANGE_LABELS) {
      row.appendChild(el("td", null, nf.format(data.ranges[range]?.[field] ?? 0)));
    }
    table.appendChild(row);
  }
  return table;
};

// Simple bar chart. Inline width is set via CSSOM, which the page's
// Content-Security-Policy allows (it only blocks inline style attributes in
// markup and inline <script>).
const makeChart = (daily) => {
  const wrap = el("section", "stats-card");
  wrap.appendChild(el("h2", null, "Chat-Anfragen pro Tag (30 Tage)"));

  if (!daily || daily.length === 0) {
    wrap.appendChild(el("p", "stats-empty", "Noch keine Daten."));
    return wrap;
  }

  const max = Math.max(...daily.map((d) => d.count), 1);
  const chart = el("div", "stats-chart");
  for (const day of daily) {
    const col = el("div", "stats-bar-col");
    col.title = `${day.day}: ${nf.format(day.count)}`;
    const bar = el("div", "stats-bar");
    bar.style.height = `${Math.max(2, Math.round((day.count / max) * 100))}%`;
    col.appendChild(bar);
    col.appendChild(el("span", "stats-bar-label", day.day.slice(8)));
    chart.appendChild(col);
  }
  wrap.appendChild(chart);
  return wrap;
};

const BREAKDOWN_RANGES = [
  ["d30", "30 Tage"],
  ["month", "Monat"],
  ["year", "Jahr"],
];

const makeBars = (rows, emptyText) => {
  if (!rows || rows.length === 0) return el("p", "stats-empty", emptyText);

  const max = rows[0].count || 1;
  const list = el("div", "stats-bars");
  for (const row of rows) {
    const line = el("div", "stats-barline");
    line.appendChild(el("span", "stats-barline-label", row.name));
    const track = el("span", "stats-barline-track");
    const fill = el("span", "stats-barline-fill");
    fill.style.width = `${Math.max(2, Math.round((row.count / max) * 100))}%`;
    track.appendChild(fill);
    line.appendChild(track);
    line.appendChild(el("span", "stats-barline-value", nf.format(row.count)));
    list.appendChild(line);
  }
  return list;
};

/**
 * byRange is {d30, month, year}. All three arrive with the response, so the
 * buttons only swap what is rendered — no further request.
 */
const makeBreakdown = (title, byRange, emptyText) => {
  const wrap = el("section", "stats-card");

  const head = el("div", "stats-cardhead");
  head.appendChild(el("h2", null, title));

  const toggle = el("div", "stats-toggle");
  const body = el("div");
  const buttons = [];

  const show = (key) => {
    body.innerHTML = "";
    body.appendChild(makeBars(byRange?.[key], emptyText));
    for (const b of buttons) {
      const active = b.dataset.range === key;
      b.classList.toggle("is-active", active);
      b.setAttribute("aria-pressed", String(active));
    }
  };

  for (const [key, label] of BREAKDOWN_RANGES) {
    const button = el("button", "stats-toggle-btn", label);
    button.type = "button";
    button.dataset.range = key;
    button.addEventListener("click", () => show(key));
    toggle.appendChild(button);
    buttons.push(button);
  }

  head.appendChild(toggle);
  wrap.appendChild(head);
  wrap.appendChild(body);
  show("d30");
  return wrap;
};

// Today's budget. Unlike everything else on this page these are live limiter
// counters, not stored history — they reset at midnight (UTC) and on restart.
// The page says so, because a bar that silently jumped back to zero after a
// deploy would look like lost data.
const pct = (used, limit) => (limit > 0 ? Math.min(100, (used / limit) * 100) : 0);

const makeMeter = (label, used, limit, hint) => {
  const line = el("div", "quota-line");

  const head = el("div", "quota-head");
  head.appendChild(el("span", "quota-label", label));
  head.appendChild(el("span", "quota-value", `${nf.format(used)} / ${nf.format(limit)}`));
  line.appendChild(head);

  const track = el("div", "quota-track");
  const fill = el("div", "quota-fill");
  const share = pct(used, limit);
  fill.style.width = `${Math.max(share > 0 ? 1.5 : 0, share)}%`;
  // Colour is a warning, not decoration: past 75% the day can still run out.
  if (share >= 90) fill.classList.add("is-critical");
  else if (share >= 75) fill.classList.add("is-warn");
  track.appendChild(fill);
  line.appendChild(track);

  if (hint) line.appendChild(el("div", "quota-hint", hint));
  return line;
};

const makeQuota = (quota) => {
  const wrap = el("section", "stats-card");
  wrap.appendChild(el("h2", null, "Tagesbudget"));

  if (!quota) {
    wrap.appendChild(el("p", "stats-empty", "Keine Budgetdaten."));
    return wrap;
  }

  const codes = el("div", "quota-group");
  if (!quota.codes || quota.codes.length === 0) {
    codes.appendChild(el("p", "stats-empty", "Keine gültigen Chat-Codes."));
  } else {
    for (const code of quota.codes) {
      const name = code.label ? `${code.school} · ${code.label}` : code.school;
      codes.appendChild(makeMeter(name, code.used, code.limit));
    }
  }
  wrap.appendChild(codes);

  const perPerson = el("div", "quota-group");
  perPerson.appendChild(
    makeMeter(
      "Meiste Anfragen aus einer Sitzung",
      quota.sessions.busiest,
      quota.sessions.limit,
      `${nf.format(quota.sessions.active)} Sitzungen heute aktiv, zusammen ${nf.format(quota.sessions.used)} Anfragen`
    )
  );
  perPerson.appendChild(
    makeMeter(
      "Meiste Anfragen aus einem Browser",
      quota.browsers.busiest,
      quota.browsers.limit,
      `${nf.format(quota.browsers.active)} Browser heute aktiv, zusammen ${nf.format(quota.browsers.used)} Anfragen`
    )
  );
  wrap.appendChild(perPerson);

  wrap.appendChild(
    el(
      "p",
      "stats-note",
      "Zählt seit Mitternacht (UTC) und seit dem letzten Neustart des Dienstes — der " +
        "spätere von beiden. Diese Zahlen werden nicht gespeichert."
    )
  );
  return wrap;
};

const makeSystem = (sys) => {
  const wrap = el("section", "stats-card");
  wrap.appendChild(el("h2", null, "Server"));
  const grid = el("div", "stats-tiles");

  const tile = (label, value, hint) => {
    const t = el("div", "stats-tile");
    t.appendChild(el("div", "stats-tile-value", value));
    t.appendChild(el("div", "stats-tile-label", label));
    if (hint) t.appendChild(el("div", "stats-tile-hint", hint));
    return t;
  };

  grid.appendChild(tile("Auslastung jetzt", `${Math.round(sys.load1 * 100)}%`, `${sys.cpuCount} Kerne`));
  grid.appendChild(tile("Auslastung 15 Min", `${Math.round(sys.load15 * 100)}%`));
  grid.appendChild(tile("Arbeitsspeicher", `${sys.memUsedPercent}%`, `von ${sys.memTotalGb} GB`));
  if (sys.disk) {
    grid.appendChild(tile("Festplatte", `${sys.disk.usedPercent}%`, `${sys.disk.freeGb} GB frei`));
  }
  grid.appendChild(tile("Läuft seit", `${sys.uptimeHours} h`));

  wrap.appendChild(grid);
  wrap.appendChild(
    el("p", "stats-note", "Diese Werte sind Momentaufnahmen und werden nicht gespeichert.")
  );
  return wrap;
};

const render = (data) => {
  statsBody.innerHTML = "";

  const overview = el("section", "stats-card");
  overview.appendChild(el("h2", null, "Überblick"));
  overview.appendChild(makeTable(data));
  statsBody.appendChild(overview);

  statsBody.appendChild(makeQuota(data.quota));
  statsBody.appendChild(makeChart(data.daily));
  statsBody.appendChild(
    makeBreakdown("Anbieter", data.providers, "Noch keine Antworten gezählt.")
  );
  statsBody.appendChild(
    makeBreakdown("Modelle", data.models, "Noch keine Antworten gezählt.")
  );
  statsBody.appendChild(makeSystem(data.system));

  const foot = el("section", "stats-card");
  foot.appendChild(el("h2", null, "Was hier gespeichert wird"));
  const ul = el("ul", "stats-list");
  for (const line of [
    "Nur Tageszähler — eine Zahl pro Tag und Kennzahl.",
    "Keine IP-Adressen, keine Uhrzeiten, keine Gesprächsinhalte.",
    `Zahlen älter als ${data.retentionDays} Tage werden automatisch gelöscht.`,
  ]) {
    ul.appendChild(el("li", null, line));
  }
  foot.appendChild(ul);
  foot.appendChild(
    el("p", "stats-note", `Stand: ${new Date(data.generatedAt).toLocaleString("de-DE")}`)
  );
  statsBody.appendChild(foot);
};

const load = async () => {
  try {
    const resp = await fetch("/api/stats");
    if (resp.status === 401) return false;
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      statsBody.innerHTML = "";
      statsBody.appendChild(el("p", "error", body.error || "Statistik nicht verfügbar."));
      return true;
    }
    render(await resp.json());
    return true;
  } catch {
    statsBody.innerHTML = "";
    statsBody.appendChild(el("p", "error", "Netzwerkfehler."));
    return true;
  }
};

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.hidden = true;
  const code = codeInput.value.trim();
  if (!code) return;

  let body = {};
  try {
    const resp = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    body = await resp.json().catch(() => ({}));
    if (!resp.ok || !body.ok) {
      loginError.textContent = body.error || "Login fehlgeschlagen.";
      loginError.hidden = false;
      return;
    }
  } catch {
    loginError.textContent = "Netzwerkfehler. Versuch es gleich noch mal.";
    loginError.hidden = false;
    return;
  }

  if (body.scope !== "stats") {
    loginError.textContent =
      "Dieser Code ist ein normaler Schulcode. Für die Statistik brauchst du einen Statistik-Code.";
    loginError.hidden = false;
    return;
  }

  codeInput.value = "";
  showView("stats");
  await load();
});

reloadBtn.addEventListener("click", load);

logoutBtn.addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" }).catch(() => {});
  showView("login");
});

(async () => {
  showView((await load()) ? "stats" : "login");
})();
