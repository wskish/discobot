#!/bin/bash
#---
# name: Install dependencies
# type: file
# pattern: "{package.json,pnpm*.yaml}"
#---
pnpm install --frozen-lockfile 2>&1 || pnpm install 2>&1
