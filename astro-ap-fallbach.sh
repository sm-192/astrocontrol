#!/bin/bash

LOG="[AstroAP]"
TIMEOUT=30   # Aumentei um pouco para dar folga ao DHCP

echo "$LOG Iniciando verificação de rede..."

# Aguarda o hardware do rádio e o NetworkManager estabilizarem
sleep 10

# Verifica se há redes WiFi disponíveis (mesmo se AP estiver ativo)
echo "$LOG Verificando redes disponíveis..."
AVAILABLE_NETWORKS=$(nmcli -t -f SSID dev wifi list | grep -v '^$' | wc -l)

if [ "$AVAILABLE_NETWORKS" -gt 0 ]; then
    echo "$LOG $AVAILABLE_NETWORKS redes encontradas. Tentando conectar..."

    # Desativa AP temporariamente para permitir scan/conexão
    nmcli con down AstroPi-AP 2>/dev/null

    # Aguarda desativação
    sleep 3

    # Tenta conectar automaticamente a redes conhecidas
    nmcli con up --ask no 2>/dev/null

    # Verifica rapidamente se conectou (timeout curto para não perder acesso)
    for j in $(seq 1 10); do
        WIFI_STATUS=$(nmcli -t -g DEVICE,STATE dev | grep "^wlan0:connected")
        if [ ! -z "$WIFI_STATUS" ]; then
            echo "$LOG Conectado com sucesso a rede conhecida!"
            exit 0
        fi
        sleep 1
    done

    # Se não conectou, reativa AP imediatamente para não perder acesso
    echo "$LOG Não conectou - reativando AP para manter acesso..."
    nmcli con up AstroPi-AP
fi

# Loop de verificação para novas conexões
for i in $(seq 1 $TIMEOUT); do
    WIFI_STATUS=$(nmcli -t -g DEVICE,STATE dev | grep "^wlan0:connected")

    if [ ! -z "$WIFI_STATUS" ]; then
        echo "$LOG Wi-Fi conectado (wlan0:connected) → não precisa de AP"
        exit 0
    fi

    echo "$LOG Aguardando Wi-Fi ($i/$TIMEOUT)..."
    sleep 1
done

echo "$LOG Nenhuma rede encontrada após timeout → ativando AP"

# Ativa o Ponto de Acesso
nmcli con up AstroPi-AP

exit 0