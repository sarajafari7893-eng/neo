#!/bin/bash
# Try standard openssl cipher/KDF combos against the .enc backup.
# Success = decrypted output starts with "PK" (ZIP magic).
ENC=/home/z/my-project/upload/nexus-snapshot-20260908-193109.zip.enc
PASS='BF0W9fnhkiws/89JoIrTW4yK1ZdO498k'
OUT=/home/z/my-project/upload/decrypted-test.zip
rm -f "$OUT"

try_one() { # $1 = cipher, extra args in $2...
  local c="$1"; shift
  openssl enc -d "-$c" "$@" -in "$ENC" -out "$OUT" -pass pass:"$PASS" 2>/dev/null || return 1
  head -c 4 "$OUT" 2>/dev/null | grep -q "PK"
}

# Modern KDF first (OpenSSL 1.1.0+ default recommendation)
for c in aes-256-cbc aes-256-ctr aes-256-cfb aes-192-cbc aes-128-cbc camellia-256-cbc des3; do
  if try_one "$c" -pbkdf2; then echo "HIT: pbkdf2 cipher=$c"; exit 0; fi
done

# Legacy EVP_BytesToKey with various digest defaults
for md in md5 sha1 sha256 sha512; do
  for c in aes-256-cbc aes-256-ctr aes-256-cfb aes-192-cbc aes-128-cbc des3; do
    if try_one "$c" -md "$md"; then echo "HIT: legacy md=$md cipher=$c"; exit 0; fi
  done
done

echo "NO HIT — none of the standard combos produced a ZIP"
exit 1
