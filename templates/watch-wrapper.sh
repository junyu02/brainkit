#!/bin/sh
# brainkit-watch-wrapper v1
set -eu

if [ "$#" -ne 4 ]; then
  echo "usage: watch-wrapper.sh FSWATCH WATCH_ROOT NODE HANDLER" >&2
  exit 64
fi

"$1" -r "$2" | "$3" "$4"
