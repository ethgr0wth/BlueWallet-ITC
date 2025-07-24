#!/bin/bash
# Run this inside your cloned BlueWallet directory

echo "🔄 Replacing Interchained references with Interchained..."
find . -type f -not -path '*/\.*' -exec sed -i 's/Interchained/Interchained/g' {} +
find . -type f -not -path '*/\.*' -exec sed -i 's/INTERCHAINED/INTERCHAINED/g' {} +
find . -type f -not -path '*/\.*' -exec sed -i 's/ITC/ITC/g' {} +


