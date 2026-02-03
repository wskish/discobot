#!/bin/bash
#---
# name: Discobot UI
# description: Vite + React Router UI development server
# http: 3000
#---

SQL_DUMP="${WORKSPACE_PATH}/test.db.sql"
DB="/home/discobot/.local/share/discobot/discobot.db"
if [ ! -e $DB ] && [ -e "${SQL_DUMP}" ]; then
    sqlite3 $DB < "${SQL_DUMP}"
fi
pnpm install && pnpm dev
