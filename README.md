# KI Hackdays Chat

Mentor*innen KI Chat für die [Projektseite](https://makeyourschool.de) und ki-hackdays.de. Schüler*innen loggen sich mit einem Schulcode ein und sprechen mit einem LLM, das auf das Wissen der Mentor*innen aus den Repos der [Projekt-Organisation auf GitHub](https://github.com/Make-Your-School) zurückgreift (RAG).

**Nicht-Ziele:** Langfristige Speicherung, Accounts, Analytics, Fine-Tuning. Wenn der Tab zu ist, ist der Chat weg.

## Stack

- **Backend:** [Bun](https://bun.sh/) + [Hono](https://hono.dev/). Ein einziger Prozess, ~500 Zeilen TypeScript.
- **Retrieval:** SQLite + [sqlite-vec](https://github.com/asg017/sqlite-vec), lokale Embeddings via [transformers.js](https://github.com/huggingface/transformers.js) mit `multilingual-e5-small` (384-dim, ~120 MB).
- **LLM:** [Google AI Studio](https://aistudio.google.com/) (Gemini, free tier) als primärer Provider, [OpenRouter](https://openrouter.ai/) als automatischer Fallback. Beide im Streaming-Modus über den OpenAI-kompatiblen Endpoint. Modell-Listen sind git-versioniert unter `server/models/`.
- **Frontend:** Single-Page, vanilla HTML/CSS/JS. Kein Build-Step. History lebt in `sessionStorage`.
- **Reverse-Proxy / TLS:** [Caddy](https://caddyserver.com/).
- **Hosting:** Hetzner Cloud CX11 (Debian 12).

## Verzeichnisstruktur

```
.
├── server/
│   ├── src/            Hono app + RAG + auth + chat
│   ├── scripts/        Admin CLIs (code.ts, embed.ts)
│   ├── models/         Git-versionierte Modell-Listen pro Provider
│   ├── .env.example    Config-Template
│   └── package.json
├── frontend/           Statische Files (vom server ausgeliefert)
├── deploy/             Caddyfile + systemd-Units
└── README.md           (diese Datei)
```

## Was wird gespeichert — und was nicht

**Gespeichert:**
- `server/data/codes.db` — Hash (SHA-256) der Schulcodes + Schule + Ablaufdatum. Plaintext-Codes werden nicht gespeichert.
- `server/data/knowledge.db` — Embeddings + Chunks aus den öffentlichen Repos. Enthält keine personenbezogenen Chat-Daten.
- `server/data/transformers-cache/` — lokaler Cache des Embedding-Modells (~120 MB), damit es nicht bei jedem Lauf neu geladen wird.

**Nicht gespeichert:**
- Keine Conversation-Logs (weder Inhalt noch Metadaten).
- Keine personenbeziehbaren IDs, keine Session-Tabelle.
- Keine Access-Logs mit Request-Inhalt (nur Fehler-Stacktraces).
- Conversation-History lebt im `sessionStorage` des Browsers — weg beim Tab-Schließen.
- Rate-Limit-Counter sind in-memory — Server-Restart setzt sie zurück.

---

## Lokale Entwicklung

### Voraussetzungen

- [Bun](https://bun.sh/) ≥ 1.1 (`curl -fsSL https://bun.sh/install | bash`)
- Git
- Ein API-Key für mindestens einen LLM-Provider:
  - **Gemini** (empfohlen, gratis): [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)
  - Übersicht zu kostenlosen API-Ressourcen und Limits für Google AI Studio: [cheahjs/free-llm-api-resources – Google AI Studio](https://github.com/cheahjs/free-llm-api-resources?tab=readme-ov-file#google-ai-studio)
  - **OpenRouter** (Backup): [openrouter.ai](https://openrouter.ai/) → Keys

### Setup

```bash
cd server
cp .env.example .env
# .env öffnen und mindestens GEMINI_API_KEY (oder OPENROUTER_API_KEY) +
# AUTH_SECRET setzen. AUTH_SECRET generieren mit:  openssl rand -hex 32
#
# Welche Modelle benutzt werden, steht NICHT in der .env, sondern in
#   server/models/gemini.txt
#   server/models/openrouter.txt
# (committed, also einfach editieren und committen)

bun install

# Ersten Schulcode erstellen
bun scripts/code.ts new "Testschule" --days=7
# → gibt einen 6-Zeichen-Code aus. Kopieren — wird nicht nochmal angezeigt.

# Server starten
bun run dev
```

Dann `http://localhost:3000` öffnen, mit dem Code einloggen.

**Ohne `knowledge.db`** (frischer Checkout, noch nicht embedded) funktioniert der Chat ohne RAG-Kontext — der System-Prompt des Mentor*innen KI Chats greift trotzdem. Um RAG zu aktivieren:

```bash
bun scripts/embed.ts
```

Das klont alle Repos der Projekt-Organisation, embedded sie und schreibt `data/knowledge.db`. Beim ersten Lauf lädt transformers.js das Embedding-Modell (~120 MB) — danach ist es gecached.

---

## Deployment auf Hetzner CX11

Diese Anleitung ist **linear**: du arbeitest dich von oben nach unten durch. Alle Befehle läufst du als `root` — wenn etwas als `kihd` laufen muss, steht da `sudo -iu kihd bash -c '...'`. Du brauchst nur eine einzige SSH-Session (außer für den SSH-Hardening-Test in Schritt 7 — da eine zweite Session parallel aufmachen).

Jeder Schritt hat einen **Check** am Ende. Wenn der Check fehlschlägt, nicht weitermachen — Fehler hierher kopieren.

### Voraussetzungen, bevor du loslegst

- [ ] Projekt ist auf GitHub gepusht. Wenn das Repo public ist und du per HTTPS klonst (`https://github.com/...`), braucht der Server keinen GitHub-SSH-Key. Nur bei privatem Repo oder SSH-Clone (`git@github.com:...`) braucht das Konto `kihd` einen GitHub-Key unter `/home/kihd/.ssh`. Die Repo-URL brauchst du gleich als `<REPO_URL>`.
- [ ] Du hast einen Gemini-API-Key (kostenlos unter [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)) und/oder einen OpenRouter-API-Key (unter [openrouter.ai](https://openrouter.ai/) → Keys → Create Key). Mindestens einer reicht; wenn du beide setzt, dient OpenRouter automatisch als Fallback, falls Gemini ausfällt.
- [ ] Deine Domain `ki-hackdays.de` ist bei einem Registrar gekauft, du kommst an die DNS-Einstellungen ran.
- [ ] Dein lokaler SSH-Public-Key (meist `~/.ssh/id_ed25519.pub` oder `~/.ssh/id_rsa.pub`) ist bei Hetzner Cloud im Account hinterlegt.

---

### 1. Server bei Hetzner Cloud bestellen

Im Hetzner Cloud Webinterface → „Add Server":

- **Image:** Debian 12
- **Typ:** CX22 (2 GB RAM — CX11 wäre knapp fürs Embedding-Modell)
- **Location:** Nürnberg oder Falkenstein (EU für DSGVO)
- **SSH-Key:** deinen Key auswählen
- **Name:** `ki-hackdays`

**Check:** du siehst den Server im Dashboard mit einer IPv4-Adresse. Schreib sie dir auf — sie heißt im Rest der Anleitung `<SERVER_IP>`.

---

### 2. Hetzner Cloud Firewall (JETZT, nicht später)

Das ist die erste Verteidigungslinie. Im Hetzner Cloud Webinterface → „Firewalls" → „Create Firewall".

Inbound Rules:

| Port  | Proto | Source         | Zweck              |
|-------|-------|----------------|--------------------|
| 22    | TCP   | `0.0.0.0/0, ::/0` | SSH             |
| 80    | TCP   | `0.0.0.0/0, ::/0` | HTTP (ACME)     |
| 443   | TCP   | `0.0.0.0/0, ::/0` | HTTPS (Chat)    |
| ICMP  | —     | `0.0.0.0/0, ::/0` | Ping (optional) |

Outbound: alles erlauben (Default).

Unter „Apply to" deinen Server `ki-hackdays` auswählen.

**Check:** Firewall ist erstellt und dem Server zugewiesen.

---

### 3. Erste SSH-Verbindung

Von deinem lokalen Rechner:

```bash
ssh root@<SERVER_IP>
```

Beim ersten Mal fragt er nach dem Host-Key — mit `yes` bestätigen.

**Check:** du siehst einen Prompt `root@ki-hackdays:~#`. Ab hier bleiben alle weiteren Befehle auf dem Server, in dieser Session.

---

### 4. System-Update und Basispakete

```bash
apt update && apt upgrade -y
apt install -y \
  caddy \
  ufw \
  unattended-upgrades \
  fail2ban \
  git \
  curl \
  ca-certificates \
  unzip
```

Automatische Security-Updates aktivieren:

```bash
dpkg-reconfigure -plow unattended-upgrades
```

Im Dialog: **Yes** wählen.

**Check:**

```bash
caddy version && git --version && unzip -v | head -1
```

Drei Versionszeilen müssen kommen. Wenn nicht: `apt install` nochmal und Fehler anschauen.

---

### 5. App-Konto `kihd` anlegen

```bash
adduser --disabled-password --gecos "" kihd
mkdir -p /home/kihd/.ssh
cp /root/.ssh/authorized_keys /home/kihd/.ssh/authorized_keys
chown -R kihd:kihd /home/kihd/.ssh
chmod 700 /home/kihd/.ssh
chmod 600 /home/kihd/.ssh/authorized_keys
usermod -aG sudo kihd
```

**Check (WICHTIG — nicht überspringen):** in einer **zweiten lokalen Shell** (die root-Session offen lassen!):

```bash
ssh kihd@<SERVER_IP>
```

Muss ohne Passwort-Abfrage durchgehen und dir `kihd@ki-hackdays:~$` zeigen. Dann die zweite Shell wieder schließen und in der root-Session weitermachen. Wenn es nicht geht: **STOPP** — erst den SSH-Zugang für kihd fixen, bevor du zu Schritt 6 gehst.

---

### 6. SSH härten

```bash
cat > /etc/ssh/sshd_config.d/00-hardening.conf <<'EOF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
MaxAuthTries 3
EOF

systemctl restart ssh
```

**Check (auch WICHTIG):** in einer **dritten lokalen Shell** (die root-Session *weiterhin* offen lassen):

```bash
ssh kihd@<SERVER_IP>
```

Muss funktionieren. Falls nicht — in der root-Session das oben erstellte File wieder löschen und ssh neu starten:

```bash
rm /etc/ssh/sshd_config.d/00-hardening.conf
systemctl restart ssh
```

Erst wenn der `kihd`-Login klappt, die root-Session zumachen und ab hier mit `ssh kihd@<SERVER_IP>` + `sudo -i` arbeiten. Wichtig: Im Repo unter `/opt/ki-hackdays` Git-Kommandos nicht direkt als `root` ausführen, weil das Repo `kihd` gehört und Git sonst später mit `detected dubious ownership` blockt.

---

### 7. UFW (OS-Firewall, defense-in-depth)

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
```

**Check:**

```bash
ufw status
```

Sollte zeigen: `Status: active` und die drei Regeln für 22, 80, 443.

---

### 8. Bun als `kihd` installieren

**Wichtig:** Bun wird *für das Konto `kihd`* installiert und landet unter `/home/kihd/.bun/bin/bun`. Genau auf diesen absoluten Pfad zeigt die systemd-Unit später — Bun muss **nicht** auf einem PATH erscheinen, weder für root noch für `kihd`.

```bash
sudo -iu kihd bash -c 'curl -fsSL https://bun.sh/install | bash'
```

**Check (eindeutig, ohne PATH-Abhängigkeit):**

```bash
ls -l /home/kihd/.bun/bin/bun
sudo -u kihd /home/kihd/.bun/bin/bun --version
```

Muss die Datei zeigen und eine Version `1.x.x` ausgeben. Wenn ja → weiter zu Schritt 9.

**Was du ignorieren kannst:**

- `bun --help` als root → `command not found`. Erwartet: bun ist für kihd installiert, nicht für root.
- `sudo -iu kihd bash -c 'bun --version'` → manchmal „command not found", weil `bash -c` die `.bashrc` nicht sourced. Deshalb verwenden die späteren Deploy-Befehle explizit `/home/kihd/.bun/bin/bun`.

### Optional vor Schritt 9: GitHub-SSH-Key für private Repos wiederherstellen

Diesen Abschnitt brauchst du **nur**, wenn dein Repo **privat** ist oder du in Schritt 9 per SSH-URL clonst (`git@github.com:...`). Bei einem **öffentlichen Repo + HTTPS-URL** kannst du ihn komplett überspringen.

Wichtig: Der GitHub-Key gehört zum Konto `kihd`, weil `git clone` und spätere `git pull`-Befehle als `kihd` laufen. `authorized_keys` ist davon getrennt: Das regelt nur, wer sich per SSH **auf den Server** einloggen darf.

Folgende Dateien sind unter `/home/kihd/.ssh/` relevant:

- `id_ed25519` — privater Schlüssel für den Zugriff **von diesem Server auf GitHub**
- `id_ed25519.pub` — passender Public Key; diesen bei GitHub als SSH-Key oder Deploy-Key hinterlegen
- `known_hosts` — merkt sich den Host-Key von `github.com`
- `authorized_keys` — **nicht** für GitHub; diese Datei wurde in Schritt 5 für den Login **auf den Server** eingerichtet

Wenn du den privaten Schlüssel im Passwort-Tresor gesichert hast, spiele ihn so zurück:

```bash
sudo -iu kihd
mkdir -p ~/.ssh
chmod 700 ~/.ssh
nano ~/.ssh/id_ed25519
chmod 600 ~/.ssh/id_ed25519
ssh-keygen -y -f ~/.ssh/id_ed25519 > ~/.ssh/id_ed25519.pub
chmod 644 ~/.ssh/id_ed25519.pub
ssh-keyscan github.com >> ~/.ssh/known_hosts
chmod 644 ~/.ssh/known_hosts
exit
```

Wenn du `id_ed25519.pub` ebenfalls im Tresor hast, kannst du sie statt `ssh-keygen -y ...` auch direkt als Datei anlegen.

**Check:**

```bash
sudo -u kihd ssh -T git@github.com
```

GitHub antwortet typischerweise mit `Hi <username>! You've successfully authenticated, but GitHub does not provide shell access.` Dann kannst du in Schritt 9 als `<REPO_URL>` auch eine SSH-URL wie `git@github.com:<user>/mys_ki.git` verwenden.

---

### 9. Projekt nach `/opt/ki-hackdays` klonen

`/opt` gehört root, aber wir wollen, dass `kihd` das Repo besitzt. Also: Ordner mit root anlegen, ownership an kihd geben, dann als kihd klonen.

```bash
mkdir -p /opt/ki-hackdays
chown kihd:kihd /opt/ki-hackdays

sudo -iu kihd bash -c 'git clone <REPO_URL> /opt/ki-hackdays'
```

`<REPO_URL>` durch deine tatsächliche GitHub-URL ersetzen (z.B. `https://github.com/matthiasm/mys_ki.git`).

**Check:**

```bash
ls -la /opt/ki-hackdays
```

Muss einen `.git`-Ordner + `server/`, `frontend/`, `deploy/`, `README.md` zeigen. Owner überall `kihd`.

---

### 10. `.env` konfigurieren

```bash
sudo -u kihd cp /opt/ki-hackdays/server/.env.example /opt/ki-hackdays/server/.env
```

Ein starkes AUTH_SECRET generieren und direkt in die `.env` schreiben:

```bash
AUTH_SECRET=$(openssl rand -hex 32)
sudo -u kihd sed -i "s|^AUTH_SECRET=.*|AUTH_SECRET=$AUTH_SECRET|" /opt/ki-hackdays/server/.env
```

Jetzt die `.env` editieren und mindestens einen Provider-Key eintragen:

```bash
sudo -u kihd nano /opt/ki-hackdays/server/.env
```

Mindestens diese Zeilen müssen korrekt gesetzt sein:

```
GEMINI_API_KEY=AIzaSy...                 # empfohlen, kostenlos
OPENROUTER_API_KEY=sk-or-v1-...          # optional, dient als Fallback
PROVIDER_ORDER=gemini,openrouter         # Reihenfolge der Versuche
AUTH_SECRET=...                          # wurde oben bereits gesetzt
NODE_ENV=production
HOST=127.0.0.1                           # WICHTIG: nicht 0.0.0.0
PORT=3000
```

Welche konkreten Modelle benutzt werden, steht **nicht** in der .env, sondern git-versioniert in `server/models/gemini.txt` und `server/models/openrouter.txt` — die werden automatisch live (mtime-cached) gelesen.

Speichern: `Ctrl-O`, `Enter`, `Ctrl-X`.

Rechte sperren:

```bash
chmod 600 /opt/ki-hackdays/server/.env
```

**Check:**

```bash
ls -l /opt/ki-hackdays/server/.env
```

Muss `-rw------- 1 kihd kihd ... .env` zeigen (nur kihd darf lesen).

---

### 11. Dependencies installieren und data-Ordner anlegen

```bash
sudo -iu kihd bash -c 'cd /opt/ki-hackdays/server && /home/kihd/.bun/bin/bun install'
sudo -u kihd mkdir -p /opt/ki-hackdays/server/data
```

**Check:**

```bash
ls /opt/ki-hackdays/server/node_modules | head
```

Muss Ordner wie `hono`, `sqlite-vec`, `@huggingface` zeigen. Wenn Fehler bei `bun install` auftauchen (z.B. ein Package braucht einen C-Compiler) — Fehler hierher kopieren, *nicht* blind `apt install build-essential` machen.

### 11a. Schulcodes auf dem Server anlegen

Admin-CLIs unter `server/scripts/` immer als `kihd` und mit absolutem Bun-Pfad ausführen. **Nicht** direkt als `root`: Bun ist fuer `kihd` installiert, und ein Root-Lauf kann root-eigene Dateien in `server/data/` anlegen.

Ein Schulcode, der 365 Tage gueltig ist:

```bash
sudo -iu kihd bash -c 'cd /opt/ki-hackdays/server && /home/kihd/.bun/bin/bun scripts/code.ts new "Meine Schule" --days=365'
```

Vorhandene Codes anzeigen:

```bash
sudo -iu kihd bash -c 'cd /opt/ki-hackdays/server && /home/kihd/.bun/bin/bun scripts/code.ts list'
```

Wenn du als `root` in `/opt/ki-hackdays/server` stehst und `bun scripts/code.ts ...` nur `command not found` liefert, ist das erwartbar und kein Fehler im Deploy.

---

### 12. Systemd-Units installieren und Service starten

```bash
cp /opt/ki-hackdays/deploy/ki-hackdays.service /etc/systemd/system/
cp /opt/ki-hackdays/deploy/ki-hackdays-embed.service /etc/systemd/system/
cp /opt/ki-hackdays/deploy/ki-hackdays-embed.timer /etc/systemd/system/

systemctl daemon-reload
systemctl enable --now ki-hackdays.service
```

**Check:**

```bash
systemctl status ki-hackdays.service
```

Muss `active (running)` zeigen. Die letzten Log-Zeilen sollten enthalten:

```
[ki-hackdays] listening on http://127.0.0.1:3000
[ki-hackdays] provider chain: gemini -> openrouter
[ki-hackdays] gemini models: gemini-2.5-flash, gemini-2.0-flash (live from .../models/gemini.txt)
[ki-hackdays] openrouter models: meta-llama/llama-3.3-70b-instruct:free, ... (live from .../models/openrouter.txt)
```

Wenn stattdessen `active (running)` kommt, aber keine Listening-Zeile, oder der Service in `failed` kippt:

```bash
journalctl -u ki-hackdays.service -n 50 --no-pager
```

und die Ausgabe hierher kopieren.

Wenn du dort `code=killed, status=31/SYS` oder `signal=SYS` siehst, ist die systemd-Sandbox zu streng für die aktuelle Bun-Version. Dann die Unit aus dem Repo nochmal nach `/etc/systemd/system/` kopieren, `systemctl daemon-reload` ausführen und den Service neu starten.

**Zweiter Check** — lauscht der Server nur auf loopback?

```bash
ss -tlnp | grep 3000
```

Muss zeigen: `LISTEN 0 ... 127.0.0.1:3000 ...`. Wenn da `0.0.0.0:3000` steht, ist die `.env` falsch — `HOST=127.0.0.1` fehlt. Korrigieren, dann `systemctl restart ki-hackdays.service`.

---

### 13. DNS setzen

Bei deinem Domain-Registrar (wo du `ki-hackdays.de` gekauft hast) zwei A-Records anlegen:

| Name            | Typ  | Ziel                |
|-----------------|------|---------------------|
| `@` (oder leer) | A    | `<SERVER_IP>`       |
| `www`           | A    | `<SERVER_IP>`       |

Optional dieselben als `AAAA` mit der IPv6-Adresse des Servers (Hetzner hat standardmäßig IPv6).

**Check (vom Server aus):**

```bash
apt install -y dnsutils
dig +short ki-hackdays.de
dig +short www.ki-hackdays.de
```

Beide müssen `<SERVER_IP>` ausgeben. **Wenn nicht: warten.** DNS-Propagation dauert meist Minuten, kann aber bis zu Stunden brauchen. Erst weitermachen, wenn beide richtig auflösen, sonst scheitert Caddy beim Zertifikat.

---

### 14. Caddy konfigurieren und starten

```bash
cp /opt/ki-hackdays/deploy/Caddyfile /etc/caddy/Caddyfile
systemctl reload caddy
```

Caddy holt sich jetzt **automatisch** ein Let's-Encrypt-Zertifikat. Das dauert ~10–30 Sekunden.

**Check:**

```bash
journalctl -u caddy -n 30 --no-pager
```

Suche nach `certificate obtained successfully` oder `serving initial configuration`. Wenn du Fehler wie `unable to obtain certificate` siehst: DNS stimmt noch nicht (Schritt 13) oder Port 80 ist blockiert.

Dann von außen testen (von deinem lokalen Rechner, nicht vom Server):

```bash
curl -I https://ki-hackdays.de
```

Muss `HTTP/2 200` oder `HTTP/1.1 200 OK` liefern.

---

### 15. Erstes RAG-Embedding

```bash
systemctl start ki-hackdays-embed.service
journalctl -u ki-hackdays-embed.service -f
```

Beim ersten Lauf passiert viel:
1. transformers.js lädt das Embedding-Modell (~120 MB) nach `server/data/transformers-cache/`
2. git clont alle Repos der Projekt-Organisation auf GitHub
3. Jedes Repo wird gechunked und embedded

Rechne mit 2–10 Minuten. Am Ende steht `[embed] done — N total chunks`. Die Unit startet danach automatisch `ki-hackdays.service` neu, damit der neue `knowledge.db` geladen wird.

Mit `Ctrl-C` aus `journalctl -f` aussteigen.

**Check:**

```bash
ls -lh /opt/ki-hackdays/server/data/knowledge.db
```

Muss eine Datei > 1 MB zeigen.

Jetzt den nächtlichen Timer aktivieren:

```bash
systemctl enable --now ki-hackdays-embed.timer
systemctl list-timers ki-hackdays-embed.timer
```

Läuft ab jetzt jede Nacht um 03:00 automatisch.

---

### 16. Ersten Schulcode erstellen

```bash
sudo -iu kihd bash -c 'cd /opt/ki-hackdays/server && /home/kihd/.bun/bin/bun scripts/code.ts new "Fürsti3!"'
```

Ausgabe sieht so aus:

```
Schulcode erstellt:

  Code:    MK4XQP
  Schule:  Testschule
  Gültig:  7 Tage
```

Der Code wird **nicht nochmal angezeigt**. Schreib ihn dir kurz auf.

---

### 17. Smoke-Test

1. Im Browser `https://ki-hackdays.de` öffnen
2. Schulcode eingeben, einloggen
3. Frage stellen, z.B. „Was sind typische Projekte für einen Schul-Hackday?"
4. Streaming-Antwort sollte reinkommen, unter der Antwort steht „Quellen:" mit klickbaren GitHub-Links zu den Repos bzw. Dateien, aus denen der RAG-Kontext kam

Wenn das klappt: **fertig.** Glückwunsch.

Wenn nicht: siehe [Troubleshooting](#troubleshooting). Die häufigsten Probleme stehen da drin.

---
Übersicht kostenloser API LLMs

https://github.com/cheahjs/free-llm-api-resources?tab=readme-ov-file#google-ai-studio

---

### Updates einspielen (für später)

Wenn du am Repo was änderst und auf den Server bringen willst:

```bash
sudo -iu kihd bash -c 'cd /opt/ki-hackdays && git pull'
sudo -iu kihd bash -c 'cd /opt/ki-hackdays/server && /home/kihd/.bun/bin/bun install'
systemctl restart ki-hackdays.service
```

Wenn die Änderungen das RAG/Embedding betreffen oder du einfach **sofort** einen frischen Index bauen willst, direkt danach zusätzlich:

```bash
systemctl start ki-hackdays-embed.service
journalctl -u ki-hackdays-embed.service -f
```

Die Embed-Unit baut `knowledge.db` neu und startet nach erfolgreichem Lauf `ki-hackdays.service` automatisch neu. Dafür ist **kein zusätzlicher manueller Restart** nötig.

Nicht stattdessen als `root` in `/opt/ki-hackdays` `git pull` ausführen — dann kommt `fatal: detected dubious ownership`, weil das Repo absichtlich `kihd` gehört.

Bei reinen Frontend-Änderungen reicht `git pull` — Caddy liefert die neuen statischen Files sofort aus, kein Restart nötig.

---

## Bedienung im Alltag

### Schulcodes verwalten

```bash
sudo -iu kihd bash -c 'cd /opt/ki-hackdays/server && /home/kihd/.bun/bin/bun scripts/code.ts new "Schulname" --label="April-Hackdays" --days=7'
sudo -iu kihd bash -c 'cd /opt/ki-hackdays/server && /home/kihd/.bun/bin/bun scripts/code.ts list'
sudo -iu kihd bash -c 'cd /opt/ki-hackdays/server && /home/kihd/.bun/bin/bun scripts/code.ts revoke <hash-prefix>'
sudo -iu kihd bash -c 'cd /opt/ki-hackdays/server && /home/kihd/.bun/bin/bun scripts/code.ts prune'    # alle abgelaufenen löschen
```

Die Liste zeigt nur den **Hash-Präfix** (erste 8 Hex-Zeichen) — den Plaintext-Code kannst du nicht mehr rausfinden, nur revoken.

### RAG manuell neu embedden

```bash
systemctl start ki-hackdays-embed.service
journalctl -u ki-hackdays-embed.service -f
```

Das kannst du jederzeit auslösen, auch wenn schon ein `knowledge.db` existiert. Typische Fälle:

- Ein neues Repo ist in der Organisation aufgetaucht.
- Du hast Änderungen an `server/scripts/embed.ts`, `server/src/rag.ts` oder an den Prompt-/Linking-Regeln deployt.
- Du willst nach einem `git pull` nicht auf den nächtlichen Timer warten.

Die Unit baut die Embedding-Datenbank neu und startet danach den Chat-Service automatisch neu.

### Modell wechseln oder Liste anpassen

Modell-Listen leben git-versioniert unter `/opt/ki-hackdays/server/models/`:

- `gemini.txt` — Gemini-Modelle in Fallback-Reihenfolge
- `openrouter.txt` — OpenRouter-Modelle in Fallback-Reihenfolge

Eine Modell-ID pro Zeile, `#` ist Kommentar. Beide Dateien werden vom Server **live** gelesen (mtime-cached) — Änderung ist beim nächsten Chat-Request aktiv, kein Restart nötig.

Empfohlener Workflow: lokal editieren, committen, auf dem Server `git pull`. Quick & dirty geht auch direkt auf dem Server (`nano models/gemini.txt`), aber dann **unbedingt** zurückcommitten, sonst geht's beim nächsten Pull verloren.

Modell-IDs finden:
- Gemini: [ai.google.dev/gemini-api/docs/models](https://ai.google.dev/gemini-api/docs/models)
- OpenRouter free tier: [openrouter.ai/models?max_price=0](https://openrouter.ai/models?max_price=0)

### Provider-Reihenfolge umdrehen

Wenn du OpenRouter zuerst probieren willst, in der `.env`:

```
PROVIDER_ORDER=openrouter,gemini
```

Dann `systemctl restart ki-hackdays.service`. Im Chat-UI siehst du danach unter jeder Antwort, welcher Provider und welches konkrete Modell sie geliefert hat (z.B. `via OpenRouter · meta-llama/llama-3.3-70b-instruct:free`).

### Logs

```bash
journalctl -u ki-hackdays.service -f               # App-Logs
journalctl -u ki-hackdays-embed.service --since "1 week ago"
journalctl -u caddy -n 50                          # TLS / Request-Probleme
```

Fuer gezieltes Debugging von RAG, Quellen, Bildauswahl und Provider-Fallbacks kannst du in der `.env` temporaer aktivieren:

```env
DEBUG_BYPASS_AUTH=1
DEBUG_CHAT_PIPELINE=1
DEBUG_CHAT_INCLUDE_CONTENT=1
DEBUG_CHAT_PREVIEW_CHARS=240
```

Dann:

```bash
systemctl restart ki-hackdays.service
journalctl -u ki-hackdays.service -f
```

Mit `DEBUG_BYPASS_AUTH=1` startet die App direkt ohne Schulcode-Login. Das ist nur fuer kurzes Debugging gedacht und sollte auf einem oeffentlich erreichbaren Server nicht aktiv bleiben.

Wichtig: `DEBUG_CHAT_INCLUDE_CONTENT=1` schreibt gekuerzte Vorschauen von Nutzer*innen-Fragen, RAG-Kontext und Assistant-Antworten ins Journal. Danach wieder ausschalten.

### Rate-Limit hochsetzen

In `.env`:

```
RATE_LIMIT_PER_CODE_PER_DAY=100
```

Restart. In-memory-Counter werden dabei zurückgesetzt — das ist bei diesem Ansatz normal.

---

## Sicherheitsmodell (Kurzfassung)

- **Bun-Prozess lauscht nur auf 127.0.0.1**. Nichts kommt am Reverse-Proxy vorbei.
- **Caddy macht TLS** und setzt HSTS + Basis-Security-Headers.
- **Zwei Firewall-Ebenen**: Hetzner-Cloud-Firewall (Infra) + UFW (OS).
- **Schulcode-Brute-Force**: 32^6 ≈ 10^9 Möglichkeiten + IP-Rate-Limit (20 Login-Versuche/Stunde) + 7-Tage-Ablauf.
- **Chat-Rate-Limit**: 50/Tag pro Schulcode gegen Abuse und um OpenRouter-Free-Quota nicht zu sprengen.
- **Cookies**: httpOnly, `SameSite=Lax`, `Secure` in Prod. HMAC-signiert, stateless.
- **Keine Plaintext-Secrets im Git**: `.env` ist in `.gitignore`, `.env.example` ist der Template.
- **Systemd-Hardening**: `ProtectSystem=strict`, `NoNewPrivileges`, private `/tmp`, read-only `/home`, …

**Bekannte Grenzen:**
- LLM-Output ist nicht gefiltert. Prompt-Injection durch Schüler*innen kann den Ton des Mentor*innen KI Chats kippen. Im worst case: ein unpassender Witz. Kein Daten-Exfil-Risiko, weil der Chat keine Tools/Agenten hat.
- Free-Models bei OpenRouter können jederzeit verschwinden oder harte Rate-Limits bekommen. Plan B: $5–20 Credits aufladen, Modell wechseln.

---

## Troubleshooting

**`ki-hackdays.service` startet nicht**

```bash
journalctl -u ki-hackdays.service -n 50
```

Häufige Ursachen:
- `.env` fehlt oder `OPENROUTER_API_KEY` nicht gesetzt → `Missing required env var`
- Falscher `WorkingDirectory` / Pfad zu `bun` → ExecStart-Fehler
- Port 3000 schon belegt → `EADDRINUSE`
- `code=killed, status=31/SYS` oder `signal=SYS` → die systemd-Unit ist zu hart eingeschränkt; aktuelle Version aus `deploy/ki-hackdays.service` nach `/etc/systemd/system/` kopieren, `systemctl daemon-reload`, dann `systemctl restart ki-hackdays.service`

**`https://ki-hackdays.de` liefert Connection refused**

- DNS noch nicht propagiert? `dig +short ki-hackdays.de`
- Caddy läuft nicht? `systemctl status caddy`
- Hetzner-Cloud-Firewall blockt 443?

**Caddy kann kein Zertifikat holen**

`journalctl -u caddy -n 100 | grep -i error`

Meistens: Port 80 blockiert (Firewall) oder DNS zeigt auf die falsche IP. Caddy braucht Port 80 für die HTTP-01 Challenge.

**Chat antwortet nur „kein Kontext"**

Das heißt, `knowledge.db` fehlt oder ist leer. Check:
```bash
ls -lh /opt/ki-hackdays/server/data/knowledge.db
```

Wenn nicht vorhanden: `systemctl start ki-hackdays-embed.service` und auf Abschluss warten.

**Rate-Limit nervt beim Testen**

```bash
systemctl restart ki-hackdays.service
```

Wischt alle in-memory Counter.

**Embedding-Pipeline schlägt bei einem Repo fehl**

Log anschauen:
```bash
journalctl -u ki-hackdays-embed.service --since "1 hour ago"
```

Einzelne fehlgeschlagene Repos überspringt das Script automatisch — der Gesamtlauf bricht nur ab, wenn der DB-Write fehlschlägt.

Wenn du `EROFS: read-only file system ... node_modules/@huggingface/transformers/.cache` oder `Failed to restart ki-hackdays.service: Access denied` siehst, läuft noch eine alte Version von Code oder Unit. Dann `git pull`, die aktuelle `deploy/ki-hackdays-embed.service` nochmal nach `/etc/systemd/system/` kopieren, `systemctl daemon-reload` ausführen und den Embed-Job neu starten.

**OpenRouter gibt 429 oder 402**

Free-Model-Quota ausgeschöpft oder Modell wurde umbenannt. Kurzfristig: anderes Free-Model in `.env` setzen + restart. Mittelfristig: Credits aufladen.

---

## Schema-Änderungen am RAG

Wenn du das Embedding-Modell wechselst oder die Vector-Dimension änderst, ist die alte `knowledge.db` inkompatibel. In dem Fall einmal komplett neu aufbauen:

```bash
rm /opt/ki-hackdays/server/data/knowledge.db
systemctl start ki-hackdays-embed.service
```

Die embed-Unit restartet den Chat-Service danach automatisch.
