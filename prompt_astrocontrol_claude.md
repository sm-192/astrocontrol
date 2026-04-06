# AstroControl — Documento de Contexto do Projeto

> Use este documento para retomar o projeto numa nova sessão.
> Cole o conteúdo abaixo como primeira mensagem ou como contexto inicial.

---

## Resumo do projeto

Estamos construindo uma interface web PWA chamada **AstroControl** para controlar um setup de astrofotografia baseado em Raspberry Pi 5, acessível via tablet/smartphone no campo. A interface é híbrida: parte nativa (montagem, alinhamento, rede) e parte via noVNC (KStars, PHD2, Desktop).

---

## Hardware do setup

| Componente | Detalhes |
|---|---|
| Computador | Raspberry Pi 5 (8GB) |
| SO | Raspberry Pi OS Lite 64-bit (Bookworm/Trixie) |
| Hostname | AstroPi (`samu192@AstroPi`) |
| IP local | 192.168.18.18 |
| Câmera | Canon EOS (DSLR) — `indi_canon_ccd` via USB, sem cartão SD |
| Montagem | Equatorial impressa em 3D, próxima de EQ — controlada por FYSETC E4 + OnStep via EQMod |
| Focalizador | Eletrônico — `indi_moonlite` via `/dev/ttyUSB1` |
| Roda de filtros | `indi_efw` — reconectando (driver pendente) |
| Rotacionador | Ainda sem driver — sugestão: `indi_arduinorot` para DIY |
| GPS | M8N com compass — NMEA via `/dev/ttyAMA0` |
| Acelerômetro | ADXL345 via SPI |
| Declinação magnética | ~−21.4° (Belo Horizonte, MG) |
| Latitude | −19.92° |

---

## Software instalado no Pi

| Serviço | Porta | Status |
|---|---|---|
| KStars 3.8.1 | — | `/usr/bin/kstars` |
| indiserver | 7624 | Sobe com KStars |
| INDI Web Manager | 8624 | Serviço systemd `indiweb` |
| PHD2 | — | `/usr/bin/phd2` |
| gpsd | 2947 | A configurar |
| dnsmasq | 53 | Instalado, configurado com `address=/astropi.local/0.0.0.0` |
| NetworkManager | — | v1.52.1 |
| AP WiFi | — | Configurado como `AstroPi-AP` (autoconnect=no), 10.0.0.1/24 |
| ttyd | 7681 | A instalar |
| noVNC KStars | 6080 | A configurar |
| noVNC PHD2 | 6081 | A configurar |
| noVNC Desktop | 6082 | A configurar |
| Node.js bridge | 3000 | A implementar |

### Serviços systemd criados

**`/etc/systemd/system/kstars-headless.service`**
```ini
[Unit]
Description=KStars Headless
After=network.target gpsd.service

[Service]
Type=simple
User=samu192
Environment=QT_QPA_PLATFORM=offscreen
ExecStart=/usr/bin/kstars
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

**`/etc/systemd/system/indiweb.service`**
```ini
[Unit]
Description=INDI Web Manager
After=network.target

[Service]
Type=simple
User=samu192
ExecStart=/home/samu192/.local/bin/indi-web -v
Restart=on-failure

[Install]
WantedBy=multi-user.target
```
> Nota: indiweb instalado do GitHub (`pip3 install git+https://github.com/knro/indiwebmanager.git`) devido a incompatibilidade do pacote PyPI com Python 3.13.

**`/etc/systemd/system/astro-ap-watchdog.service`**
```ini
[Unit]
Description=AstroPi AP Watchdog
After=network.target NetworkManager.service

[Service]
Type=simple
ExecStart=/usr/local/bin/astro-ap-watchdog.sh
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

### Script AP watchdog
**`/usr/local/bin/astro-ap-watchdog.sh`**
```bash
#!/bin/bash
AP_CON="AstroPi-AP"
CHECK_INTERVAL=30

while true; do
    STA_CONNECTED=$(nmcli -t -f STATE general | grep -c "connected")
    AP_ACTIVE=$(nmcli con show --active | grep -c "$AP_CON")

    if [ "$STA_CONNECTED" -eq 0 ] && [ "$AP_ACTIVE" -eq 0 ]; then
        logger "astro-ap-watchdog: STA desconectado, ativando AP"
        nmcli con up "$AP_CON"
    fi

    sleep "$CHECK_INTERVAL"
done
```

---

## Próximos passos pendentes

### No Pi (quando disponível)

1. **Instalar e configurar gpsd**
```bash
sudo apt install gpsd gpsd-clients -y
sudo nano /etc/default/gpsd
# START_DAEMON="true"
# DEVICES="/dev/ttyAMA0"
# GPSD_OPTIONS="-n -F /var/run/gpsd.sock -s 9600"
# USBAUTO="false"
sudo systemctl enable gpsd && sudo systemctl start gpsd
```
> Driver INDI: usar **`indi_gpsd`** (cliente TCP do GPSD) — não driver serial direto.
> Watchdog: `samu192 ALL=(ALL) NOPASSWD: /bin/systemctl restart gpsd` em `/etc/sudoers.d/astrocontrol`

2. **Configurar Astrometry.net**
```bash
sudo apt install astrometry.net -y
sudo apt install astrometry-data-tycho2-10-19 -y
```

3. **Instalar ttyd (terminal web)**
```bash
sudo apt install ttyd -y
```
Serviço systemd:
```ini
[Unit]
Description=ttyd Terminal
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/ttyd --credential samu192:SUASENHA --port 7681 login
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

4. **Configurar noVNC (3 instâncias)**
```bash
sudo apt install xvfb x11vnc novnc -y
```
- Display `:1` → KStars → noVNC porta 6080
- Display `:2` → PHD2 → noVNC porta 6081
- Display `:3` → Desktop geral → noVNC porta 6082 (com senha VNC)

5. **Instalar Node.js e deploy da PWA**
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install nodejs -y
```

6. **Script Python bridge** (ADXL345 + compass + gpsd → WebSocket)
   - Implementado: `bridge.py` (v1.0)
   - Lê SPI (ADXL345), I2C (compass HMC5883L ou QMC5883L — auto-detect)
   - Consome GPSD via socket TCP (localhost:2947) — **não acessa `/dev/ttyAMA0` diretamente**
   - Estratégia de Snapshot: aguarda 3D Fix, coleta 5 amostras, descarta extremos, calcula média
   - Calcula declinação magnética com `pyIGRF` e persiste em `/dev/shm/astro_env.json`
   - Watchdog: reinicia gpsd via systemctl se sem update por 60s
   - Publica pitch, roll, heading, true_heading, lat, lon via WebSocket na porta 8765

---

## Arquitetura da interface

```
PWA (porta 3000)
├── Aba Montagem     → controle nativo (joystick, GoTo, rastreamento)
├── Aba Alinhamento  → nativo (barras lat/dec, nível 2D, bússola) ← dados do Python bridge
├── Aba KStars       → iframe noVNC :6080
├── Aba PHD2         → iframe noVNC :6081
├── Aba Desktop      → iframe noVNC :6082 (com senha)
├── Aba Terminal     → iframe ttyd :7681 (com usuário/senha)
├── Aba Drivers      → status dos drivers INDI + toggles
└── Aba Rede         → toggle AP, status WiFi, status serviços
```

---

## Interface (código fonte completo)

O código da interface está na última versão do widget gerado na conversa.
Para recriar, peça ao Claude:

> "Recrie a interface AstroControl v4 com as seguintes abas: Montagem (joystick + GoTo + rastreamento), Alinhamento (barra vertical de latitude, barra horizontal de declinação magnética, nível de bolha 2D unificado para pitch+roll, bússola polar com norte magnético e norte real), KStars (noVNC iframe porta 6080), PHD2 (noVNC iframe porta 6081), Desktop (noVNC iframe porta 6082 com auth por senha VNC), Terminal (ttyd iframe porta 7681 com auth usuário+senha), Drivers (lista de dispositivos com toggles e log INDI), Rede (status STA/AP, toggle AP manual, lista de serviços). Tema escuro, otimizado para tablet em paisagem 16:9."

---

## Decisões de arquitetura tomadas

- **Sem RTC externo** — Pi 5 tem RTC interno; GPS M8N é fonte primária de tempo via gpsd + PPS
- **GPS no Pi** (não no OnStep) — OnStep consome gpsd via rede TCP (protocolo nativo)
- **KStars modo offscreen** (`QT_QPA_PLATFORM=offscreen`) — sem Xvfb para operação normal; noVNC usa displays virtuais separados
- **Imagens salvas no Pi** — `indi_canon_ccd` modo `local`, sem cartão SD na câmera
- **AP automático** — sobe sozinho quando sem WiFi; desligado em casa; toggle manual na aba Rede
- **astropi.local** — resolvido via dnsmasq no modo AP; no modo STA depende do roteador ou edição do `/etc/hosts`
- **Autenticação** — KStars e PHD2 sem senha (rede local fechada); Desktop e Terminal com senha
- **GPSD — Single Source of Truth** — único processo com acesso a `/dev/ttyAMA0`; driver INDI `indi_gpsd` e `bridge.py` são clientes via TCP (porta 2947). Evita conflito de porta serial entre indiserver e bridge.
- **Declinação magnética via Snapshot** — calculada uma vez após 3D Fix estável (média de 5 amostras); cacheada em `/dev/shm/astro_env.json`; recarregada automaticamente após reboot.

---

## Compass (pendente)

O modelo do compass do GPS M8N ainda não foi identificado.
- Se `i2cdetect -y 1` mostrar `0x1E` → HMC5883L
- Se mostrar `0x0D` → QMC5883L
- Confirmar antes de escrever o script Python bridge

---

## Notas de instalação

- **Python**: 3.13.5 instalado — `cgi` module removido, atenção com pacotes legados
- **indiweb**: instalar do GitHub, não do PyPI (incompatível com Python 3.13)
- **Swap**: configurado como 4GB em `/etc/dphys-swapfile` (`CONF_SWAPSIZE=2048` mas resultou em 4GB)
- **X11**: configurado via `raspi-config` (Wayland desabilitado)
- **KStars**: compilado via script `nou/astro-soft-build` (build-soft-stable), versão 3.8.1
- **PHD2**: compilado via mesmo script, requereu `libwxgtk3.2-dev`
- **Compilação**: feita dentro de sessão `tmux` para sobreviver a desconexões SSH
