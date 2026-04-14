# Admin-User verwalten

Konto-Modell auf der Produktions-Maschine:

- **`kihd`** — Service-User. Kein Login-Passwort, kein sudo. Führt ausschließlich `ki-hackdays.service` aus.
- **`matthias` (oder weitere Personen-Accounts)** — Admin-User. Login per SSH-Key, sudo mit Passwort.
- **`root`** — per SSH gesperrt (`PermitRootLogin no` in [00-hardening.conf](00-hardening.conf)), zusätzlich Account-locked (`passwd -l root`). Zugang nur noch über die Hetzner-Konsole nach "Reset root password".

Es gibt zwei Situationen, in denen du einen Admin-User anlegen willst:

- [Weg 1: Du bist ausgesperrt](#weg-1-du-bist-ausgesperrt) — niemand kommt mehr per SSH auf die Kiste.
- [Weg 2: Ein weiterer Admin kommt dazu](#weg-2-ein-weiterer-admin-kommt-dazu) — du bist selbst drauf und legst einen neuen User an.

---

## Weg 1: Du bist ausgesperrt

Passiert, wenn Root-SSH deaktiviert ist und der einzige Admin-User kein Passwort und/oder keinen funktionierenden Key mehr hat. Es gibt zwei Untervarianten:

- **1a — "Reset root password"** (schnell, kein Reboot) setzt den `qemu-guest-agent` auf der Maschine voraus.
- **1b — Rescue-System** (immer verfügbar) bootet ein Live-Linux, von dem aus du die Platte mountest und änderst.

Probier erst 1a. Wenn die Cloud-Console "Guest Agent nicht vorhanden" meldet, nimm 1b.

### Variante 1a: Root-Passwort via Guest Agent injizieren

1. [console.hetzner.cloud](https://console.hetzner.cloud) → Projekt → Server auswählen.
2. Button **"Reset root password"** (je nach UI-Version im Tab *Power* oder direkt auf der Server-Übersicht).
3. Hetzner zeigt dir ein einmaliges Passwort — wegkopieren.
4. Im Cloud-UI: Server → **Console** (Web-VNC). `PermitRootLogin no` gilt nur für SSH; die lokale Konsole ignoriert das.
   ```
   ki-hackdays login: root
   Password: <das Einmal-PW>
   ```
5. Weiter bei [Admin-User anlegen](#admin-user-anlegen).

### Variante 1b: Rescue-System

1. Cloud Console → Server → **Rescue** → "Linux 64-bit" + deinen SSH-Pubkey eintragen → **"Enable rescue & power cycle"**.
2. Auf dem Mac kurz warten (~30 s), dann alten Host-Key verwerfen und einloggen:
   ```bash
   ssh-keygen -R ki-hackdays.de
   ssh -o IdentitiesOnly=yes -i ~/.ssh/id_ed25519_priv_hetzner root@ki-hackdays.de
   ```
3. Im Rescue die Platte mounten und in's Zielsystem chrooten:
   ```bash
   mount /dev/sda2 /mnt
   mount /dev/sda1 /mnt/boot/efi
   for d in dev proc sys run; do mount --rbind /$d /mnt/$d; done
   chroot /mnt /bin/bash
   ```
4. Gleich den `qemu-guest-agent` nachinstallieren, damit Variante 1a beim nächsten Mal verfügbar ist:
   ```bash
   apt update
   apt install -y qemu-guest-agent
   systemctl enable qemu-guest-agent
   ```
5. Weiter bei [Admin-User anlegen](#admin-user-anlegen) — du bist jetzt (via chroot) "als Root auf dem Zielsystem".

### Admin-User anlegen

Egal ob via 1a oder 1b — ab hier identisch:

```bash
adduser matthias                    # setzt ein Passwort interaktiv → merken, das wird dein sudo-PW
usermod -aG sudo matthias

mkdir -p /home/matthias/.ssh
chmod 700 /home/matthias/.ssh
```

SSH-Pubkey hinterlegen. Inhalt hast du lokal via `cat ~/.ssh/id_ed25519_priv_hetzner.pub`:

```bash
cat > /home/matthias/.ssh/authorized_keys <<'EOF'
ssh-ed25519 AAAA... matthias@macbook
EOF
chmod 600 /home/matthias/.ssh/authorized_keys
chown -R matthias:matthias /home/matthias/.ssh
```

**Wenn du via Rescue (1b) hier bist:** jetzt aus dem chroot raus und zurück in's normale System:

```bash
exit                                 # chroot verlassen
umount -R /mnt
```

Dann in der Hetzner Cloud Console **"Disable rescue"** + Server einmal aus/an. Wichtig: Rescue in der UI deaktivieren *bevor* du rebootest, sonst landet der Server wieder im Rescue.

### Zweites Terminal: Login testen — WICHTIG

**Die Root-Session (Web-Konsole bzw. Rescue-SSH) nicht schließen, bevor der neue Login bestätigt funktioniert.** Sonst sperrst du dich im gleichen Zug wieder aus.

Auf dem Mac:

```bash
ssh matthias@ki-hackdays.de
sudo -v        # Passwort eingeben, sollte akzeptiert werden
```

Klappt beides → weiter. Klappt nicht → zurück in die Web-Konsole, `authorized_keys`-Berechtigungen und sshd-Logs (`journalctl -u ssh -n 50`) prüfen.

### Root wieder sperren

Solange Root ein gesetztes Passwort hat, ist es über die Web-Konsole nutzbar (bzw. nach Variante 1a über das Einmal-Reset-PW). Also dichtmachen — das kannst du nach erfolgreichem `ssh matthias@…` in deiner neuen Admin-Session tun:

```bash
sudo passwd -l root
```

Damit ist der Account-Zustand wieder *locked*. Die Hetzner-"Reset root password"-Funktion bleibt weiter verfügbar (das ist Infrastruktur-Ebene und setzt ein neues Passwort, sobald jemand sie bewusst anstößt), aber bis dahin kommt niemand über Root rein.

### Lokale SSH-Config aufräumen

In `~/.ssh/config`:

```
Host ki-hackdays.de
  User matthias
  IdentityFile ~/.ssh/id_ed25519_priv_hetzner
  IdentitiesOnly yes
```

Ab hier: `ssh ki-hackdays.de` reicht, und es wird **nur** dieser Key angeboten — verhindert das "MaxAuthTries überschritten, weil Agent zu viele andere Keys durchprobiert"-Problem.

---

## Weg 2: Ein weiterer Admin kommt dazu

Du bist bereits als `matthias` drauf, willst einen zweiten Admin (`alice`) anlegen.

### 1. User anlegen und in sudo-Gruppe packen

```bash
sudo adduser alice                  # Passwort wählt alice selbst beim ersten Login, oder du setzt ein temporäres
sudo usermod -aG sudo alice
```

### 2. Pubkey von alice hinterlegen

alice schickt dir ihren **Public Key** (niemals den Private-Key). Dann:

```bash
sudo -u alice mkdir -p /home/alice/.ssh
sudo -u alice tee /home/alice/.ssh/authorized_keys > /dev/null <<'EOF'
ssh-ed25519 AAAA... alice@laptop
EOF
sudo chmod 700 /home/alice/.ssh
sudo chmod 600 /home/alice/.ssh/authorized_keys
```

### 3. Testen (alice macht das auf ihrem Rechner)

```bash
ssh alice@ki-hackdays.de
sudo -v
```

### 4. Temporäres Passwort zurücksetzen lassen

Falls du beim `adduser` ein temporäres Passwort gesetzt hast, soll alice es beim ersten Login ändern:

```bash
sudo chage -d 0 alice               # erzwingt Passwort-Wechsel beim nächsten Login
```

---

## Warum dieses Modell

- **Named User statt generic `admin`.** Logs zeigen eindeutig, wer was gemacht hat. `sudo` landet in `/var/log/auth.log` mit echten Namen.
- **Service-User ≠ Admin-User.** `kihd` läuft nur den Bun-Prozess, hat keinen Shell-Zugang und keine Rechte auf andere Verzeichnisse. Ein Kompromittieren des Services eskaliert nicht automatisch zu System-Admin.
- **Sudo mit Passwort, nicht NOPASSWD.** Der SSH-Key ist der primäre Faktor, das sudo-Passwort ist ein schwacher Zweitfaktor — aber er hilft gegen Szenarien wie "Laptop kurz unbeaufsichtigt, Agent entsperrt". Für schnelle Scripts kannst du einzelne Kommandos per `/etc/sudoers.d/…` ohne Passwort freigeben, statt pauschal NOPASSWD zu vergeben.
- **Root gesperrt.** Ein Angreifer, der `matthias`s Key hätte, müsste zusätzlich das sudo-Passwort kennen oder ausnutzen. Root direkt anzugreifen ist nicht möglich.

## Troubleshooting

**"Permission denied (publickey)" als neuer User**
`ls -la /home/<user>/.ssh` prüfen: Verzeichnis muss `700` sein, `authorized_keys` muss `600` und dem User gehören. Bei `StrictModes yes` (default) refuse'd sshd sonst stumm.

**"Too many authentication failures"**
SSH-Agent hat zu viele Keys geladen, Server zählt jeden falschen Key. Lokal mit `IdentitiesOnly yes` in `~/.ssh/config` fixen, siehe Weg 1 Schritt 6.

**sudo fragt immer nach Passwort, obwohl User in `sudo`-Gruppe**
Normal — genau das wollen wir. Für bestimmte Kommandos (z.B. Service-Restarts im Deploy-Script) kannst du gezielt freigeben:
```
# /etc/sudoers.d/90-ki-hackdays-ops
matthias ALL=(root) NOPASSWD: /bin/systemctl restart ki-hackdays.service
```
