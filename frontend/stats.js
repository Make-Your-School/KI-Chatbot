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

// Eine Zeile ohne Balken: Zahl statt Messlatte.
//
// Für Modelle ohne eingetragenes Limit. Ein Balken braucht eine Obergrenze,
// sonst zeigt seine Länge nur den Rang innerhalb der Liste — und in einer Karte
// namens "Tagesbudget" liest sich das wie "fast voll", obwohl niemand weiß,
// wovon.
const makeCountRow = (label, count, hint) => {
  const line = el("div", "quota-line");
  const head = el("div", "quota-head");
  head.appendChild(el("span", "quota-label", label));
  head.appendChild(el("span", "quota-value", nf.format(count)));
  line.appendChild(head);
  if (hint) line.appendChild(el("div", "quota-hint", hint));
  return line;
};

/**
 * Eine Gruppe mit Überschrift und Erklärzeile.
 *
 * Die Überschriften sind nicht Deko. Ohne sie stehen da nur Schulnamen, und in
 * einem Monat weiß niemand mehr, dass hinter "Meine Schule" ein Zugangscode
 * steckt und nicht etwa eine Schule, die sich irgendwo registriert hat.
 */
const makeQuotaGroup = (title, explain) => {
  const group = el("div", "quota-group");
  group.appendChild(el("h3", "quota-group-title", title));
  if (explain) group.appendChild(el("p", "quota-group-note", explain));
  return group;
};

const plural = (n, one, many) => `${nf.format(n)} ${n === 1 ? one : many}`;

const makeQuota = (quota) => {
  const wrap = el("section", "stats-card");
  wrap.appendChild(el("h2", null, "Tagesbudget"));

  if (!quota) {
    wrap.appendChild(el("p", "stats-empty", "Keine Budgetdaten."));
    return wrap;
  }

  const codes = makeQuotaGroup(
    "Pro Zugangscode",
    "Ein Balken je gültigem Schulcode — also je Passwort, mit dem sich jemand " +
      "einloggen kann. Der Name ist die Schule, für die der Code ausgestellt wurde; " +
      "der Code selbst steht hier nirgends."
  );
  if (!quota.codes || quota.codes.length === 0) {
    codes.appendChild(el("p", "stats-empty", "Keine gültigen Chat-Codes."));
  } else {
    for (const code of quota.codes) {
      const name = code.label ? `${code.school} · ${code.label}` : code.school;
      codes.appendChild(makeMeter(name, code.used, code.limit));
    }
  }
  wrap.appendChild(codes);

  const perPerson = makeQuotaGroup(
    "Pro Person",
    "Damit eine einzelne Person nicht das Budget einer ganzen Schule aufbraucht. " +
      "Einzelne Sitzungen werden nicht aufgelistet — nur wie viele aktiv waren und " +
      "was die stärkste davon verbraucht hat."
  );
  perPerson.appendChild(
    makeMeter(
      "Meiste Anfragen aus einer Sitzung",
      quota.sessions.busiest,
      quota.sessions.limit,
      `${plural(quota.sessions.active, "Sitzung", "Sitzungen")} heute aktiv, zusammen ${plural(quota.sessions.used, "Anfrage", "Anfragen")}`
    )
  );
  perPerson.appendChild(
    makeMeter(
      "Meiste Anfragen aus einem Browser",
      quota.browsers.busiest,
      quota.browsers.limit,
      `${plural(quota.browsers.active, "Browser", "Browser")} heute aktiv, zusammen ${plural(quota.browsers.used, "Anfrage", "Anfragen")}`
    )
  );
  wrap.appendChild(perPerson);

  const models = quota.models ?? [];
  const perModel = makeQuotaGroup(
    "Pro KI-Modell",
    "Wie viele Antworten heute von welchem Modell kamen. Ein Balken steht nur " +
      "dort, wo in server/models/<anbieter>.txt ein Tageslimit hinter der " +
      "Modell-ID eingetragen ist — die Grenze gehört dem Anbieter, und eine " +
      "geratene wäre schlimmer als gar keine."
  );
  if (models.length === 0) {
    perModel.appendChild(el("p", "stats-empty", "Heute noch keine Antworten."));
  } else {
    for (const row of models) {
      perModel.appendChild(
        row.limit
          ? makeMeter(row.model, row.used, row.limit)
          : makeCountRow(row.model, row.used, "kein Tageslimit eingetragen")
      );
    }
  }
  wrap.appendChild(perModel);

  wrap.appendChild(
    el(
      "p",
      "stats-note",
      "Codes und Personen zählen seit Mitternacht (UTC) und seit dem letzten Neustart " +
        "des Dienstes — der spätere von beiden; diese Zahlen liegen nur im " +
        "Arbeitsspeicher. Die Modellzahlen kommen aus den gespeicherten Tageszählern " +
        "und überleben einen Neustart. Achtung: hier beginnt der Tag um Mitternacht " +
        "UTC, bei Google zählt der Free Tier nach Pazifik-Zeit — die Balken können " +
        "also gegeneinander verschoben sein."
    )
  );
  return wrap;
};

// ---------- Verlaufskurven der Serverwerte ----------
//
// Eine Kurve pro Kachel, gut 100 Pixel breit: keine Achsen, keine Legende, kein
// Raster. Die grosse Zahl darueber sagt "jetzt", die Kurve daneben sagt, ob das
// jetzt normal ist. Mehr soll sie nicht.

const SVG_NS = "http://www.w3.org/2000/svg";
const SPARK_W = 100;
const SPARK_H = 22;

const svgEl = (tag, attrs) => {
  const node = document.createElementNS(SVG_NS, tag);
  for (const key of Object.keys(attrs)) node.setAttribute(key, attrs[key]);
  return node;
};

const clockLabel = (t) =>
  new Date(t).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });

/**
 * `pick` holt den Prozentwert aus einem Messpunkt und gibt null zurueck, wenn
 * dieser Punkt die Kennzahl nicht hat (die Platte fehlt auf Maschinen ohne
 * statfs). `onHover` bekommt den Text, der beim Ueberfahren erscheinen soll.
 */
const makeSpark = (history, pick, onHover) => {
  const windowMs = (history?.windowHours ?? 24) * 3_600_000;
  const from = Date.now() - windowMs;
  const points = (history?.points ?? [])
    .map((p) => ({ t: p.t, v: pick(p) }))
    .filter((p) => Number.isFinite(p.v) && p.t >= from);
  if (points.length === 0) return null;

  // Prozente werden gegen die volle Skala gezeichnet, nicht gegen ihr eigenes
  // Maximum: sonst sieht ein Tag zwischen 0 % und 2 % aus wie ein Gebirge. Nur
  // wenn die Last ueber 100 % geht — mehr Arbeit als Kerne —, waechst die Skala
  // mit, damit die Spitze nicht abgeschnitten wird.
  const top = Math.max(100, ...points.map((p) => p.v));
  const x = (t) => ((t - from) / windowMs) * SPARK_W;
  const y = (v) => SPARK_H - (v / top) * SPARK_H;

  const svg = svgEl("svg", {
    class: "spark",
    viewBox: `0 0 ${SPARK_W} ${SPARK_H}`,
    // Die Kurve soll die Kachelbreite fuellen, egal wie breit die gerade ist.
    // Dass die Striche dabei nicht mitverzerren, erledigt vector-effect im CSS.
    preserveAspectRatio: "none",
    role: "img",
    focusable: "false",
  });

  svg.appendChild(svgEl("line", {
    class: "spark-base",
    x1: 0, y1: SPARK_H, x2: SPARK_W, y2: SPARK_H,
  }));

  // Fehlt laenger als zweieinhalb Messabstaende ein Punkt, wird die Kurve
  // unterbrochen statt durchgezogen. Eine gerade Linie ueber eine Luecke waere
  // eine Behauptung ueber eine Zeit, in der nichts gemessen wurde.
  const maxGap = (history?.stepMinutes ?? 5) * 60_000 * 2.5;
  const segments = [[points[0]]];
  for (let i = 1; i < points.length; i += 1) {
    if (points[i].t - points[i - 1].t > maxGap) segments.push([]);
    segments[segments.length - 1].push(points[i]);
  }

  for (const segment of segments) {
    const path = segment.map((p) => `${x(p.t).toFixed(2)},${y(p.v).toFixed(2)}`).join(" ");
    if (segment.length > 1) {
      svg.appendChild(svgEl("polygon", {
        class: "spark-area",
        points: `${x(segment[0].t).toFixed(2)},${SPARK_H} ${path} ${x(segment[segment.length - 1].t).toFixed(2)},${SPARK_H}`,
      }));
      svg.appendChild(svgEl("polyline", { class: "spark-line", points: path }));
    } else {
      // Ein einzelner Messpunkt ist keine Linie. Direkt nach einem Neustart ist
      // das der Normalfall, und ein Punkt ist ehrlicher als nichts.
      svg.appendChild(svgEl("circle", {
        class: "spark-dot", cx: x(segment[0].t).toFixed(2), cy: y(segment[0].v).toFixed(2), r: 1.6,
      }));
    }
  }

  const last = points[points.length - 1];
  svg.appendChild(svgEl("circle", {
    class: "spark-head", cx: x(last.t).toFixed(2), cy: y(last.v).toFixed(2), r: 1.8,
  }));

  // Kein schwebendes Tooltip-Kaestchen: die Kachel hat schon eine Zeile fuer
  // Kleingedrucktes, und die sagt beim Ueberfahren, welcher Wert wann war.
  if (onHover) {
    const marker = svgEl("line", {
      class: "spark-cursor", x1: 0, y1: 0, x2: 0, y2: SPARK_H, visibility: "hidden",
    });
    svg.appendChild(marker);

    svg.addEventListener("pointermove", (ev) => {
      const box = svg.getBoundingClientRect();
      if (box.width === 0) return;
      const t = from + ((ev.clientX - box.left) / box.width) * windowMs;
      let near = points[0];
      for (const p of points) {
        if (Math.abs(p.t - t) < Math.abs(near.t - t)) near = p;
      }
      marker.setAttribute("x1", x(near.t).toFixed(2));
      marker.setAttribute("x2", x(near.t).toFixed(2));
      marker.setAttribute("visibility", "visible");
      onHover(`${clockLabel(near.t)} Uhr · ${Math.round(near.v)}%`);
    });
    svg.addEventListener("pointerleave", () => {
      marker.setAttribute("visibility", "hidden");
      onHover(null);
    });
  }

  return svg;
};

const makeSystem = (sys) => {
  const wrap = el("section", "stats-card");
  wrap.appendChild(el("h2", null, "Server"));
  const grid = el("div", "stats-tiles");

  const tile = (label, value, hint, pick) => {
    const t = el("div", "stats-tile");
    t.appendChild(el("div", "stats-tile-value", value));
    t.appendChild(el("div", "stats-tile-label", label));
    // Die Hinweiszeile gibt es auch ohne Hinweistext, sobald eine Kurve da ist:
    // sie ist dann der Platz, an dem der überfahrene Messwert steht. Ohne sie
    // würde die Kachel beim Überfahren um eine Zeile wachsen.
    const hintEl = el("div", "stats-tile-hint", hint ?? "");
    const spark = pick
      ? makeSpark(sys.history, pick, (text) => {
          hintEl.textContent = text ?? (hint ?? "");
          hintEl.classList.toggle("is-reading", Boolean(text));
        })
      : null;
    if (spark) t.appendChild(spark);
    if (hint || spark) t.appendChild(hintEl);
    return t;
  };

  grid.appendChild(tile("Auslastung jetzt", `${Math.round(sys.load1 * 100)}%`, `${sys.cpuCount} Kerne`, (p) => p.load1));
  grid.appendChild(tile("Auslastung 15 Min", `${Math.round(sys.load15 * 100)}%`, null, (p) => p.load15));
  grid.appendChild(tile("Arbeitsspeicher", `${sys.memUsedPercent}%`, `von ${sys.memTotalGb} GB`, (p) => p.mem));
  if (sys.disk) {
    grid.appendChild(tile("Festplatte", `${sys.disk.usedPercent}%`, `${sys.disk.freeGb} GB frei`, (p) => p.disk));
  }
  // Keine Kurve: eine Laufzeit steigt einfach gleichmäßig an, die Linie wäre
  // immer dieselbe Diagonale und sagt nichts, was die Zahl nicht sagt.
  grid.appendChild(tile("Läuft seit", `${sys.uptimeHours} h`));

  wrap.appendChild(grid);
  wrap.appendChild(
    el(
      "p",
      "stats-note",
      `Zahlen sind Momentaufnahmen, die Kurven zeigen die letzten ` +
        `${sys.history?.windowHours ?? 24} Stunden (alle ${sys.history?.stepMinutes ?? 5} Minuten gemessen). ` +
        "Beides liegt nur im Arbeitsspeicher und beginnt nach einem Neustart von vorn — " +
        "ein kurzer Strich am rechten Rand heißt also: gerade neu gestartet."
    )
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
