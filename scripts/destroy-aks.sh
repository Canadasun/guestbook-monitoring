#!/usr/bin/env bash
# Delete the cluster created by create-aks.sh (run `pulumi destroy` first to remove the workloads cleanly).
set -euo pipefail

RG="${RG:-rg-guestbook-monitoring}"
CLUSTER="${CLUSTER:-aks-guestbook-monitoring}"

az group delete -n "$RG" --yes --no-wait
kubectl config delete-context "$CLUSTER" 2>/dev/null || true
echo "Deleting resource group $RG (the MC_* node group is removed with it)."
