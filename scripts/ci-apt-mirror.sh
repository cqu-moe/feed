#!/usr/bin/env bash
set -euo pipefail

# A slow but responsive Azure mirror never activates APT's existing fallback.
sudo sed -i \
  -e '/^http:\/\/azure\.archive\.ubuntu\.com\/ubuntu\//s/priority:1/priority:2/' \
  -e '/^https:\/\/archive\.ubuntu\.com\/ubuntu\//s/priority:2/priority:1/' \
  /etc/apt/apt-mirrors.txt
