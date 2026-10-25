#!/usr/bin/env bash
# Optional helper: create a small AKS cluster to deploy onto (any Kubernetes cluster works).
# Override any setting with environment variables, e.g. LOCATION=eastus ./scripts/create-aks.sh
set -euo pipefail

RG="${RG:-rg-guestbook-monitoring}"
CLUSTER="${CLUSTER:-aks-guestbook-monitoring}"
LOCATION="${LOCATION:-northcentralus}"
NODE_SIZE="${NODE_SIZE:-Standard_B2as_v2}"   # x86: the Guestbook images are amd64-only
NODE_COUNT="${NODE_COUNT:-2}"
# Space-separated key=value tags; some subscriptions enforce tags on every resource group,
# including the MC_* node resource group AKS creates (cluster tags propagate to it).
TAGS="${TAGS:-project=guestbook-monitoring}"

az group create -n "$RG" -l "$LOCATION" --tags $TAGS -o none
az aks create -g "$RG" -n "$CLUSTER" -l "$LOCATION" \
  --tier free --node-count "$NODE_COUNT" --node-vm-size "$NODE_SIZE" \
  --generate-ssh-keys --tags $TAGS -o none
az aks get-credentials -g "$RG" -n "$CLUSTER" --overwrite-existing
kubectl get nodes -o wide
