#!/bin/bash
#---
# name: Go mod tidy
# type: file
# pattern: "**/go.mod"
#---
for f in $DISCOBOT_CHANGED_FILES; do
	dir=$(dirname "$f")
	(cd "$dir" && go mod tidy 2>&1)
done
