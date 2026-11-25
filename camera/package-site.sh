#!/bin/sh
# Assemble the static site and a portable hardware source download.
set -eu
cd "$(dirname "$0")"
staging=$(mktemp -d)
trap 'rm -r -- "$staging"' EXIT
bundle="$staging/ov9281-camera"
mkdir -p "$bundle/host" dist
cp -R rtl tb "$bundle/"
cp README.md cam.lpf build.sh placement.py placement_min.py package-site.sh "$bundle/"
cp host/index.html host/chdr_log.md host/server.py "$bundle/host/"
cp -R site "$bundle/"
tar -czf dist/ov9281-camera-source.tar.gz -C "$staging" ov9281-camera
cp site/index.html site/camera.css site/camera.js dist/
