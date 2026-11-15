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
#   BACKEND_RELAY_CERT_DAYS server certificate validity in days (default 365)
#   BACKEND_RELAY_CA_DAYS   CA validity in days (default 3650)

CERT="${BACKEND_RELAY_CERT:-/data/tls/server.pem}"
KEY="${BACKEND_RELAY_KEY:-/data/tls/server.key}"
CA="${BACKEND_RELAY_CA:-/data/tls/ca.pem}"
SAN="${BACKEND_RELAY_SAN:-DNS:localhost,IP:127.0.0.1}"
# Apple's TLS policy rejects server certificates whose lifetime exceeds 825
# days (verified against macOS 27's Security framework: 825 days passes, 826
# fails with errSSLXCertChainInvalid). The private CA itself is not subject to
# that leaf limit, but the leaf must stay well under it.
DAYS="${BACKEND_RELAY_CERT_DAYS:-365}"
CA_DAYS="${BACKEND_RELAY_CA_DAYS:-3650}"

if [ -f "$CERT" ] && [ -f "$KEY" ]; then
  echo "backend relay certificate already exists; not overwriting: $CERT"
  # A leaf issued with the earlier 3650-day default is rejected by Apple's TLS
  # policy even when its CA is trusted. Detect it so the failure is actionable.
  leaf_end=$(openssl x509 -in "$CERT" -noout -enddate 2>/dev/null | sed 's/^notAfter=//') || leaf_end=""
  leaf_start=$(openssl x509 -in "$CERT" -noout -startdate 2>/dev/null | sed 's/^notBefore=//') || leaf_start=""
  if [ -n "$leaf_end" ] && [ -n "$leaf_start" ]; then
    end_epoch=$(date -d "$leaf_end" +%s 2>/dev/null || date -j -f "%b %e %T %Y %Z" "$leaf_end" +%s 2>/dev/null || echo "")
    start_epoch=$(date -d "$leaf_start" +%s 2>/dev/null || date -j -f "%b %e %T %Y %Z" "$leaf_start" +%s 2>/dev/null || echo "")
    if [ -n "$end_epoch" ] && [ -n "$start_epoch" ] &&
       [ $(( (end_epoch - start_epoch) / 86400 )) -gt 825 ]; then
      echo "warning: $CERT has a lifetime over 825 days and Apple's TLS policy will reject it;" >&2
      echo "reissue it with BACKEND_RELAY_CERT_DAYS<=825 (default 365) after moving the current files aside." >&2
    fi
  fi
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
    -keyout "$ca_key" -out "$CA" -days "$CA_DAYS" \
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
