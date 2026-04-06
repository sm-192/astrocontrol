# AstroControl — Guia de Instalação Completo
## Raspberry Pi 5 (8 GB) · Raspberry Pi OS Lite 64-bit (Bookworm)

> Usuário: `samu192` · Hostname: `AstroPi` · IP local: `192.168.18.18`  
> Execute os comandos nessa ordem. Itens marcados com ✓ já foram feitos em sessões anteriores.

---

## Índice rápido

| # | Software | Porta | Status |
|---|---|---|---|
| 1 | Preparação do sistema | — | — |
| 2 | INDI Framework + drivers | 7624 | ✓ Instalado |
| 3 | INDI Web Manager | 8624 | ✓ Instalado |
| 4 | KStars 3.8.1 | — | ✓ Compilado |
| 5 | PHD2 | — | ✓ Compilado |
| 6 | Guide Star Catalog (GSC) | — | Pendente |
| 7 | Astrometry.net | — | Pendente |
| 8 | StellarSolver | — | ✓ (com KStars) |
| 9 | ASTAP | — | Pendente |
| 10 | XFCE Desktop | — | Pendente |
| 11 | noVNC (remote desktop) | 6080/6081/6082 | Pendente |
| 12 | ttyd (terminal web) | 7681 | Pendente |
| 13 | gpsd | 2947 | Pendente |
| 14 | Siril | — | Pendente |
| 15 | Gnome Predict | — | Pendente |
| 16 | FireCapture | — | Pendente |
| 17 | SER Player | — | Pendente |
| 18 | AstroDMX | — | Pendente |
| 19 | CCDciel | — | Pendente |
| 20 | PHD2 Log Viewer | — | Online |
| 21 | Node.js + AstroControl PWA | 3000 | Pendente |
| 22 | Python sensor bridge | 8765 | Pendente |

---

## 1. PREPARAÇÃO DO SISTEMA

```bash
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y git curl wget build-essential cmake ninja-build \
  python3-pip python3-dev python3-venv tmux htop nano \
  pkg-config dkms fxload udev
```

### Swap (recomendado para compilações)

```bash
sudo nano /etc/dphys-swapfile
# CONF_SWAPSIZE=4096
sudo systemctl restart dphys-swapfile
```

### Desabilitar Wayland (necessário para X11/noVNC)

```bash
sudo raspi-config
# Advanced Options → Wayland → X11
sudo reboot
```

---

## 2. INDI FRAMEWORK + DRIVERS OFICIAIS

> ✓ **Já instalado** via script `nou/astro-soft-build`.

Para verificar:
```bash
indiserver --version
ls /usr/bin/indi_*
```

Para reinstalar do zero:
```bash
# Dependências de compilação
sudo apt install -y \
  libcfitsio-dev libnova-dev libusb-1.0-0-dev libftdi-dev \
  libgphoto2-dev libraw-dev libjpeg-dev libtiff-dev \
  libfftw3-dev libgsl-dev libboost-regex-dev \
  libcurl4-gnutls-dev libev-dev libgps-dev libdc1394-dev \
  libavcodec-dev libavdevice-dev libavformat-dev libswscale-dev \
  libkrb5-dev librtlsdr-dev

git clone https://gitea.nouspiro.space/nou/astro-soft-build.git
cd astro-soft-build
./install-dependencies.sh
./build-soft-stable.sh        # INDI core + KStars (~2-3h no Pi 5)
./build-soft-stable.sh phd2   # PHD2 separado
cd ~
```

### Serviço KStars headless (já existe)

```bash
sudo systemctl status kstars-headless
```

---

## 3. INDI WEB MANAGER

> ✓ **Já instalado** via GitHub (PyPI é incompatível com Python 3.13).

Para verificar:
```bash
systemctl status indiweb
curl -s http://localhost:8624/api/server/status | python3 -m json.tool
```

Para reinstalar:
```bash
pip3 install git+https://github.com/knro/indiwebmanager.git \
  --break-system-packages
```

---

## 4. KSTARS 3.8.1

> ✓ **Já compilado** em `/usr/bin/kstars`.

---

## 5. PHD2 AUTOGUIDING

> ✓ **Já compilado** em `/usr/bin/phd2`.

O serviço `phd2-display.service` (display `:2` via noVNC porta 6081) é configurado pelo `setup-novnc.sh`.

### PHD2 Log Viewer

O PHD2 Log Viewer é uma ferramenta online — não requer instalação no Pi:

- **URL:** https://openphdguiding.org/phd2-log-viewer/
- **Logs no Pi:** `~/.phd2/*.log`
- Para copiar um log para análise:
```bash
scp samu192@astropi.local:~/.phd2/PHD2_GuideLog_*.txt .
```

---

## 6. GUIDE STAR CATALOG (GSC)

Necessário para o KStars simular campos estelares e para plate solving.

```bash
sudo apt install -y gsc

# Verifica instalação:
ls /usr/share/GSC/

# Se o pacote apt não estiver disponível, instalar manualmente:
# No KStars: Settings → Configure KStars → Catalogs → Download
```

---

## 7. ASTROMETRY.NET (PLATE SOLVING)

```bash
sudo apt install -y astrometry.net

# Índices para câmeras DSLR — escolha conforme focal length:
# Campo grande (> 2°) — objetivas curtas:
sudo apt install -y astrometry-data-tycho2-10-19

# Campo médio (0.5°–2°) — teleobjetivas:
sudo apt install -y astrometry-data-2mass-08-19

# Para baixar índices específicos manualmente:
# http://data.astrometry.net/4100/ → copiar para /usr/share/astrometry/

# Testar:
solve-field --help
```

---

## 8. STELLARSOLVER

> ✓ **Compilado automaticamente junto com o KStars** (não requer instalação separada).

```bash
# Verificar:
ls /usr/local/lib/libstellarsolver*
```

---

## 9. ASTAP (PLATE SOLVING ALTERNATIVO)

ASTAP é mais rápido que Astrometry.net e funciona bem offline.

```bash
# Download do binário ARM64
cd ~
wget https://www.hnsky.org/astap_arm64.tar.gz
tar -xzf astap_arm64.tar.gz
sudo mv astap /usr/local/bin/
sudo chmod +x /usr/local/bin/astap
rm astap_arm64.tar.gz

# Banco de dados G17 (recomendado — ~1.6 GB)
mkdir -p ~/astap_data
cd ~/astap_data
wget https://www.hnsky.org/G17.zip
unzip G17.zip
rm G17.zip

# Configurar no ASTAP (quando abrir via desktop):
# File → Settings → Star database → ~/astap_data
# ou via KStars: Settings → Configure KStars → Astrometry → ASTAP

# Testar:
astap --help
```

---

## 10. XFCE DESKTOP ENVIRONMENT

O XFCE roda no display virtual `:3` e é acessado via noVNC na porta 6082.

```bash
sudo apt install -y \
  xfce4 xfce4-goodies xfce4-terminal \
  xfce4-taskmanager mousepad \
  fonts-dejavu fonts-liberation fonts-noto \
  dbus-x11 at-spi2-core \
  x11-apps x11-utils

# NÃO instala lightdm — o desktop sobe via Xvfb (headless)
# Configurado pelo setup-novnc.sh
```

---

## 11. NOVNC + XVFB + X11VNC (REMOTE DESKTOP)

Este passo configura os 3 displays virtuais e os serviços systemd correspondentes.

```bash
# Instala dependências
sudo apt install -y xvfb x11vnc novnc

# Define senha VNC para o desktop (XFCE, porta 6082)
sudo mkdir -p /etc/astrocontrol
x11vnc -storepasswd SUASENHA /etc/astrocontrol/desktop.pass
sudo chmod 600 /etc/astrocontrol/desktop.pass

# Executa o script de setup completo:
sudo bash ~/astrocontrol/setup-novnc.sh
```

Após o setup, os serviços disponíveis são:

| Display | Aplicação | VNC interno | noVNC externo |
|---|---|---|---|
| `:1` | KStars/Ekos | 5901 | http://astropi.local:6080 |
| `:2` | PHD2 | 5902 | http://astropi.local:6081 |
| `:3` | Desktop XFCE | 5903 | http://astropi.local:6082 |

```bash
# Verificar status:
systemctl status xvfb@1 xvfb@2 xvfb@3
systemctl status kstars-display phd2-display openbox-desktop
systemctl status novnc-6080 novnc-6081 novnc-6082
```

---

## 12. TTYD (TERMINAL WEB)

```bash
sudo apt install -y ttyd

# Cria serviço (ALTERE a senha antes de ativar):
sudo tee /etc/systemd/system/ttyd.service > /dev/null << 'EOF'
[Unit]
Description=ttyd Web Terminal
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/ttyd --credential samu192:SUASENHA --port 7681 login
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now ttyd

# Testar:
curl -I http://localhost:7681
```

Acesso: http://astropi.local:7681

---

## 13. GPSD

> **Arquitetura — Single Source of Truth:**
> O GPSD é o **único processo** que acessa `/dev/ttyAMA0` diretamente.
> O driver INDI (`indi_gpsd`), o `bridge.py` e o Chrony (opcional) são **clientes** do GPSD via socket TCP (porta 2947).
> Isso evita conflitos de porta serial entre o indiserver e o bridge.

```bash
sudo apt install -y gpsd gpsd-clients

# Configurar para GPS M8N em /dev/ttyAMA0:
# -n  → não aguarda clientes para ativar o GPS
# -s 9600 → fixa baudrate (evita scan automático que pode travar)
# -F  → cria socket UNIX além do TCP
sudo tee /etc/default/gpsd > /dev/null << 'EOF'
START_DAEMON="true"
DEVICES="/dev/ttyAMA0"
GPSD_OPTIONS="-n -F /var/run/gpsd.sock -s 9600"
USBAUTO="false"
EOF

# Habilitar UART no Pi 5:
sudo nano /boot/firmware/config.txt
# Adicionar ao final:
# enable_uart=1
# dtoverlay=disable-bt

sudo systemctl enable gpsd
sudo systemctl start gpsd

# Testar fix GPS:
gpsmon
# ou:
cgps -s
```

### Driver INDI para GPS (indi_gpsd)

No INDI Web Manager, use o driver **`indi_gpsd`** (não um driver serial direto).
Ele conecta ao GPSD via TCP (localhost:2947), respeitando a arquitetura de cliente único.

```bash
# Verificar se o driver está disponível:
ls /usr/bin/indi_gpsd

# No KStars/Ekos: adicionar dispositivo → GPS → GPSD Client
```

### Permitir restart do GPSD pelo bridge.py (watchdog)

```bash
# Adicionar ao sudoers para permitir restart sem senha:
sudo visudo -f /etc/sudoers.d/astrocontrol
# Inserir a linha:
# samu192 ALL=(ALL) NOPASSWD: /bin/systemctl restart gpsd
```

---

## 14. SIRIL (PROCESSAMENTO DE IMAGENS DSO)

```bash
# Opção 1: via flatpak (mais simples, sem conflitos de dependências)
sudo apt install -y flatpak
flatpak remote-add --if-not-exists flathub \
  https://flathub.org/repo/flathub.flatpakrepo
flatpak install -y flathub org.free_astro.siril

# Criar atalho no XFCE:
mkdir -p ~/.local/share/applications
cat > ~/.local/share/applications/siril.desktop << 'EOF'
[Desktop Entry]
Name=Siril
Comment=Astronomical image processing
Exec=flatpak run org.free_astro.siril
Icon=siril
Type=Application
Categories=Science;Astronomy;
EOF

# Opção 2: compilar da fonte (se flatpak não funcionar)
sudo apt install -y \
  libopencv-dev libfftw3-dev libgsl-dev libcfitsio-dev \
  libgtk-3-dev intltool libconfig-dev libjson-glib-dev \
  libglib2.0-dev meson

git clone https://gitlab.com/free-astro/siril.git
cd siril
mkdir build && cd build
meson .. --buildtype=release
ninja -j4
sudo ninja install
cd ~
```

---

## 15. GNOME PREDICT (RASTREAMENTO DE SATÉLITES)

```bash
sudo apt install -y gpredict

# Criar atalho XFCE:
cat > ~/.local/share/applications/gpredict.desktop << 'EOF'
[Desktop Entry]
Name=Gpredict
Comment=Real-time satellite tracking
Exec=gpredict
Icon=gpredict
Type=Application
Categories=Science;Astronomy;
EOF

# Ao abrir, atualizar TLEs:
# Edit → Update TLE data (requer conexão com internet)
```

---

## 16. FIRECAPTURE (IMAGENS PLANETÁRIAS)

```bash
# Instala Java (requisito)
sudo apt install -y default-jre default-jdk

# Verifica versão atual em: http://www.firecapture.de/
FC_VER="2.7.13"
wget "http://www.firecapture.de/FireCapture_v${FC_VER}_Linux64.tar.gz" -O ~/firecapture.tar.gz
tar -xzf ~/firecapture.tar.gz -C ~/
rm ~/firecapture.tar.gz

FC_DIR="$HOME/FireCapture_v${FC_VER}_Linux64"
chmod +x "${FC_DIR}/FireCapture.sh"

# Instala bibliotecas de câmera (ASI/ZWO)
sudo apt install -y libusb-1.0-0 libraw1394-11

# Regras udev para câmeras ZWO:
sudo wget -O /etc/udev/rules.d/99-asi.rules \
  https://raw.githubusercontent.com/indilib/indi-3rdparty/master/indi-asi/99-asi.rules
sudo udevadm control --reload-rules && sudo udevadm trigger

# Atalho XFCE:
cat > ~/.local/share/applications/firecapture.desktop << EOF
[Desktop Entry]
Name=FireCapture
Comment=Planetary imaging capture
Exec=${FC_DIR}/FireCapture.sh
Icon=${FC_DIR}/FireCapture.png
Type=Application
Categories=Science;Astronomy;
EOF

# Iniciar (via desktop XFCE ou terminal):
# ${FC_DIR}/FireCapture.sh
```

---

## 17. SER PLAYER (VISUALIZAR VÍDEO PLANETÁRIO .SER)

**Opção A — kSER (nativo Linux, ARM64):**

```bash
sudo apt install -y \
  qt5-qmake qtbase5-dev qtmultimedia5-dev \
  libqt5multimediawidgets5 libqt5multimedia5-plugins

git clone https://github.com/j-pernot/kSER.git
cd kSER
qmake && make -j4
sudo make install
cd ~

cat > ~/.local/share/applications/kser.desktop << 'EOF'
[Desktop Entry]
Name=kSER
Comment=SER video player for astronomy
Exec=kser
Type=Application
Categories=Science;Astronomy;
EOF
```

**Opção B — usar ffplay (já disponível via ffmpeg):**

```bash
sudo apt install -y ffmpeg

# Visualizar arquivo SER diretamente:
ffplay arquivo.ser

# Criar alias conveniente:
echo "alias serplay='ffplay'" >> ~/.bashrc
source ~/.bashrc
```

> kSER é a alternativa mais próxima do SER Player Windows. Se a compilação falhar no ARM64, use ffplay como fallback — funciona bem para visualização básica.

---

## 18. ASTRODMX (SOFTWARE DE CAPTURA)

```bash
# Verificar versão ARM64 disponível em:
# https://www.astrodmx-capture.org.uk/downloads/astrodmx/

# Download (ajuste a versão conforme disponível):
wget https://www.astrodmx-capture.org.uk/downloads/astrodmx/astrodmx_latest_arm64.deb \
  -O ~/astrodmx.deb

sudo apt install -y ./astrodmx.deb
rm ~/astrodmx.deb

# SDK ASI (ZWO) — necessário para câmeras ZWO:
ASI_SDK="ASI_linux_mac_SDK_V1.36"
wget "https://download.astronomy-imaging-camera.com/download/${ASI_SDK}.tar.bz2"
tar -xjf "${ASI_SDK}.tar.bz2"
sudo cp "${ASI_SDK}/lib/armv8/"* /usr/lib/
sudo ldconfig
rm -rf "${ASI_SDK}" "${ASI_SDK}.tar.bz2"

# Testar:
astrodmx &
```

> Se o pacote `.deb` ARM64 não estiver disponível na versão mais recente, use o AstroDMX versão anterior ou substitua por **CCDciel** (seção 19) ou o **Ekos** integrado ao KStars.

---

## 19. CCDCIEL (SOFTWARE DE CAPTURA ALTERNATIVO)

CCDciel é uma alternativa ao AstroDMX, integra bem com INDI.

```bash
# Instala Lazarus/FreePascal (compilador Pascal)
sudo apt install -y lazarus fpc

# Clona e compila
git clone https://github.com/pchev/ccdciel.git
cd ccdciel

# Compila em modo release
lazbuild --bm=Release ccdciel.lpi

# Instala
sudo make install
cd ~

# Atalho XFCE:
cat > ~/.local/share/applications/ccdciel.desktop << 'EOF'
[Desktop Entry]
Name=CCDciel
Comment=CCD capture software with INDI support
Exec=ccdciel
Type=Application
Categories=Science;Astronomy;
EOF
```

> A compilação leva ~20 min no Pi 5. Se falhar por falta de memória, verifique se o swap de 4 GB está ativo (`free -h`).

---

## 20. NODE.JS + ASTROCONTROL PWA

```bash
# Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Verificar:
node --version   # v20.x.x
npm --version

# Deploy (execute no seu computador local, na pasta do projeto):
# chmod +x deploy.sh && ./deploy.sh

# Ou manualmente no Pi:
mkdir -p ~/astrocontrol
cd ~/astrocontrol
npm install

sudo cp ~/astrocontrol/astrocontrol.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now astrocontrol

# Verificar:
systemctl status astrocontrol
curl -I http://localhost:3000
```

---

## 21. PYTHON SENSOR BRIDGE (ADXL345 + COMPASS + GPS)

> **Arquitetura:** `bridge.py` consome dados do GPS via socket do GPSD (localhost:2947).
> Ele **não acessa `/dev/ttyAMA0` diretamente** — o GPSD é o único dono da serial.
>
> **Estratégia de Snapshot (declinação magnética):**
> 1. Aguarda GPS `mode >= 3` (3D Fix)
> 2. Coleta 5 amostras de lat/lon — descarta mínimo e máximo
> 3. Calcula média das 3 amostras centrais
> 4. Calcula Declinação Magnética via `pyIGRF` (modelo WMM)
> 5. Persiste resultado em `/dev/shm/astro_env.json` (RAM)
> 6. Nas inicializações seguintes, carrega o cache imediatamente

```bash
# Habilitar SPI e I2C:
sudo raspi-config
# Interface Options → SPI → Enable
# Interface Options → I2C → Enable

# Instalar dependências Python:
pip3 install --break-system-packages \
  websockets \
  spidev \
  smbus2 \
  gpsd-py3 \
  pyIGRF

# Identificar modelo do compass:
sudo i2cdetect -y 1
# 0x1E = HMC5883L  (suportado pelo bridge.py — auto-detect)
# 0x0D = QMC5883L  (suportado pelo bridge.py — auto-detect)

# Copiar bridge.py para o Pi:
scp bridge.py samu192@astropi.local:~/astrocontrol/

# Testar manualmente antes de ativar como serviço:
python3 ~/astrocontrol/bridge.py

# Criar serviço systemd:
sudo tee /etc/systemd/system/astro-sensors.service > /dev/null << 'EOF'
[Unit]
Description=AstroControl Sensor Bridge (ADXL345 + Compass + GPSD)
After=gpsd.service
Wants=gpsd.service

[Service]
Type=simple
User=samu192
ExecStart=/usr/bin/python3 /home/samu192/astrocontrol/bridge.py
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now astro-sensors

# Verificar:
systemctl status astro-sensors
journalctl -u astro-sensors -f
```

---

## 22. VERIFICAÇÃO FINAL DE TODOS OS SERVIÇOS

```bash
# Verifica status de todos os serviços de uma vez:
for svc in \
  astrocontrol \
  kstars-headless kstars-display \
  phd2-display \
  indiweb \
  xvfb@1 xvfb@2 xvfb@3 \
  x11vnc@1 x11vnc@2 x11vnc-desktop \
  novnc-6080 novnc-6081 novnc-6082 \
  openbox-desktop \
  ttyd \
  gpsd \
  astro-ap-watchdog \
  astro-sensors
do
  status=$(systemctl is-active "$svc" 2>/dev/null)
  printf "%-28s %s\n" "$svc" "$status"
done

echo ""
echo "=== Portas abertas ==="
ss -tlnp | grep -E ':3000|:7624|:8624|:6080|:6081|:6082|:7681|:2947|:8765'
```

---

## 23. TABELA DE ACESSO — BROWSER

| Serviço | URL | Observação |
|---|---|---|
| AstroControl PWA | http://astropi.local:3000 | Principal |
| INDI Web Manager | http://astropi.local:8624 | Gerenciar drivers |
| KStars / Ekos | http://astropi.local:6080 | Via noVNC |
| PHD2 Guiding | http://astropi.local:6081 | Via noVNC |
| Desktop XFCE | http://astropi.local:6082 | Via noVNC, senha VNC |
| Terminal | http://astropi.local:7681 | Via ttyd, usuário+senha |

> **Acesso em campo (modo AP):** substituir `astropi.local` por `10.0.0.1`.

---

## 24. ORDEM DE INICIALIZAÇÃO DOS SERVIÇOS

Os serviços iniciam automaticamente nesta ordem via `systemd`:

```
gpsd → kstars-headless (indiserver) → indiweb
xvfb@{1,2,3} → x11vnc@{1,2} + x11vnc-desktop → novnc-{6080,6081,6082}
              → kstars-display (display :1)
              → phd2-display (display :2)
              → openbox-desktop (display :3)
astro-ap-watchdog
ttyd
astrocontrol (Node.js PWA)
astro-sensors (Python bridge — quando implementado)
```

Para reiniciar tudo de uma vez após uma modificação:

```bash
sudo systemctl restart \
  kstars-headless indiweb \
  kstars-display phd2-display openbox-desktop \
  novnc-6080 novnc-6081 novnc-6082 \
  astrocontrol
```
