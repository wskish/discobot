#!/bin/bash
#---
# name: Discobot UI
# description: Vite + React Router UI development server
# http: 3000
#---

SQL_DUMP="${WORKSPACE_PATH}/test.db.sql"
if [ ! -e ./server/discobot.db ] && [ -e "${SQL_DUMP}" ]; then
    sqlite3 ./server/discobot.db < "${SQL_DUMP}"
fi
pnpm install && pnpm dev
