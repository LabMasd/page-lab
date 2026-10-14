#!/bin/sh
cd "$(dirname "$0")" && python3 -m http.server 8260 & sleep 1; open http://localhost:8260/index.html
