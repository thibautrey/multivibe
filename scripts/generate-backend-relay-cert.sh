#!/bin/sh
set -eu

# Generates the private CA and server certificate used by the optional
# Codex/ChatGPT backend relay listener. Existing files are never overwritten.
#
# Environment:
#   BACKEND_RELAY_CERT  server certificate path (default /data/tls/server.pem)
#   BACKEND_RELAY_KEY   server private key path (default /data/tls/server.key)
#   BACKEND_RELAY_CA    CA certificate path (default /data/tls/ca.pem)
#   BACKEND_RELAY_SAN   comma-separated SANs (default localhost,127.0.0.1)
#   BACKEND_RELAY_CERT_DAYS validity in days (default 3650)

CERT="${BACKEND_RELAY_CERT:-/data/tls/server.pem}"
KEY="${BACKEND_RELAY_KEY:-/data/tls/server.key}"
CA="${BACKEND_RELAY_CA:-/data/tls/ca.pem}"
SAN="${BACKEND_RELAY_SAN:-DNS:localhost,IP:127.0.0.1}"
DAYS="${BACKEND_RELAY_CERT_DAYS:-3650}"

if [ -f "$CERT" ] && [ -f "$KEY" ]; then
  echo "backend relay certificate already exists; not overwriting: $CERT"
  exit 0
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is required to generate the backend relay certificate" >&2
  exit 1
fi

cert_dir=$(dirname "$CERT")
mkdir -p "$cert_dir"

ca_key="${CA}.key"
if [ ! -f "$CA" ] || [ ! -f "$ca_key" ]; then
  openssl req -x509 -newkey rsa:4096 -nodes \
    -keyout "$ca_key" -out "$CA" -days "$DAYS" \
    -subj "/CN=MultiVibe Backend Relay Local CA" >/dev/null 2>&1
  chmod 600 "$ca_key"
  chmod 644 "$CA"
fi

csr="${cert_dir}/server.csr"
ext="${cert_dir}/server.ext"
openssl req -newkey rsa:4096 -nodes \
  -keyout "$KEY" -out "$csr" \
  -subj "/CN=multivibe-backend-relay" >/dev/null 2>&1

# Accept both OpenSSL SAN syntax (DNS:host,IP:addr) and bare host/IP entries.
normalized_san=""
old_ifs=$IFS
IFS=','
for entry in $SAN; do
  entry=$(printf '%s' "$entry" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  [ -z "$entry" ] && continue
  case "$entry" in
    DNS:*|IP:*|email:*|URI:*) normalized_san="${normalized_san}${entry}," ;;
    *:*:*) normalized_san="${normalized_san}IP:${entry}," ;;
    *[0-9].[0-9]*) normalized_san="${normalized_san}IP:${entry}," ;;
    *) normalized_san="${normalized_san}DNS:${entry}," ;;
  esac
done
IFS=$old_ifs
normalized_san=${normalized_san%,}
if [ -z "$normalized_san" ]; then
  echo "BACKEND_RELAY_SAN did not contain any usable entry" >&2
  exit 1
fi

cat > "$ext" <<EOF
subjectAltName=$normalized_san
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
EOF

openssl x509 -req -in "$csr" -CA "$CA" -CAkey "$ca_key" -CAcreateserial \
  -out "$CERT" -days "$DAYS" -extfile "$ext" >/dev/null 2>&1

rm -f "$csr" "$ext" "${CA}.srl"
chmod 600 "$KEY"
chmod 644 "$CERT"

echo "generated backend relay certificate: $CERT"
echo "generated backend relay CA: $CA"
echo "set CODEX_CA_CERTIFICATE=$CA on the Codex host"
