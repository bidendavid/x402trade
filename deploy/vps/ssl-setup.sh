#!/bin/bash
# SSL certificate setup using Let's Encrypt (certbot)
# Usage: ./ssl-setup.sh getx402.trade your@email.com

DOMAIN=${1:-getx402.trade}
EMAIL=${2:-admin@getx402.trade}

set -e

echo "Installing certbot..."
apt-get update -qq && apt-get install -y certbot

echo "Obtaining SSL certificate for $DOMAIN..."
certbot certonly \
  --standalone \
  --non-interactive \
  --agree-tos \
  --email "$EMAIL" \
  -d "$DOMAIN"

echo "Setting up auto-renewal..."
echo "0 3 * * * root certbot renew --quiet && docker compose -f /opt/x402trade/deploy/vps/docker-compose.prod.yml exec nginx nginx -s reload" \
  > /etc/cron.d/certbot-renew

echo "Done. Certificate stored at /etc/letsencrypt/live/$DOMAIN/"
