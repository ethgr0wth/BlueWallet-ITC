#!/usr/bin/env bash
set -euo pipefail

# 1) Ensure the network config exists
mkdir -p class/wallets
NETWORK_FILE="class/wallets/_interchained-network.ts"
if [ ! -f "$NETWORK_FILE" ]; then
  cat > "$NETWORK_FILE" <<'EOF'
export const INTERCHAINED = {
  messagePrefix: '\x18Interchained Signed Message:\n',
  bech32: 'itc',
  bip32: {
    public: 0x0488b21e,
    private: 0x0488ade4,
  },
  pubKeyHash: 0x00,
  scriptHash: 0x05,
  wif: 0x80,
};
export default INTERCHAINED;
EOF
  echo "Created $NETWORK_FILE"
fi

# 2) Files we need to touch
FILES=(
  class/wallets/legacy-wallet.ts
  class/wallets/segwit-bech32-wallet.ts
  class/wallets/segwit-p2sh-wallet.ts
  class/wallets/taproot-wallet.ts
  screen/send/Confirm.tsx
  screen/settings/SelfTest.tsx
)

for f in "${FILES[@]}"; do
  if [[ ! -f "$f" ]]; then
    echo "WARN: $f not found, skipping"
    continue
  fi

  # Decide correct relative import path
  if [[ "$f" == screen/* ]]; then
    REL='../../class/wallets/_interchained-network'
  else
    REL='./_interchained-network'
  fi

  # Add import if it's not already there
  if ! grep -q "INTERCHAINED" "$f"; then
    # Insert as first line (safe + simple)
    tmpfile="$(mktemp)"
    {
      echo "import { INTERCHAINED } from '$REL';"
      cat "$f"
    } > "$tmpfile"
    mv "$tmpfile" "$f"
    echo "Inserted INTERCHAINED import into $f"
  fi

  # Replace interchained.networks.interchained -> INTERCHAINED
  sed -i 's/interchained\.networks\.interchained/INTERCHAINED/g' "$f"
done

echo "✅ Done. Now run your build/lint to catch anything else:"
echo "   npm run lint || yarn lint"
