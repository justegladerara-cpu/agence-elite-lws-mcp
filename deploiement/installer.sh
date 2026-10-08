#!/bin/sh
# Installation sur un VPS Debian/Ubuntu neuf, en root : sh installer.sh
set -e
apt-get update -y && apt-get install -y docker.io docker-compose-v2 git openssl
# Oracle Cloud (offre gratuite) bloque les ports web dans le pare-feu du système : on ouvre 80 et 443.
if iptables -L INPUT -n 2>/dev/null | grep -q REJECT; then
  iptables -I INPUT 5 -p tcp --dport 80 -j ACCEPT && iptables -I INPUT 5 -p tcp --dport 443 -j ACCEPT
  command -v netfilter-persistent >/dev/null && netfilter-persistent save || true
fi
[ -d /opt/connecteur ] || git clone https://github.com/justegladerara-cpu/agence-elite-lws-mcp /opt/connecteur
cd /opt/connecteur/deploiement
if [ ! -f .env ]; then
  cp .env.exemple .env
  sed -i "s/^MCP_JETON=.*/MCP_JETON=$(openssl rand -hex 16)/" .env
  chmod 600 .env
  echo "Remplis LWS_LOGIN et LWS_CLE dans /opt/connecteur/deploiement/.env (nano .env), puis relance : sh installer.sh"
  exit 0
fi
docker compose up -d --build
. ./.env
echo "Adresse du connecteur : https://lws.agence-elite.fr/mcp/$MCP_JETON"
echo "IP de ce serveur à autoriser dans panel.lws.fr › Api LWS : $(curl -s https://api.ipify.org)"
