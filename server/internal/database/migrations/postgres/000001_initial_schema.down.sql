-- Drop indexes
DROP INDEX IF EXISTS idx_user_sessions_expires_at;
DROP INDEX IF EXISTS idx_user_sessions_user_id;
DROP INDEX IF EXISTS idx_terminal_history_session_id;
DROP INDEX IF EXISTS idx_credentials_project_id;
DROP INDEX IF EXISTS idx_messages_session_id;
DROP INDEX IF EXISTS idx_agents_project_id;
DROP INDEX IF EXISTS idx_sessions_agent_id;
DROP INDEX IF EXISTS idx_sessions_workspace_id;
DROP INDEX IF EXISTS idx_workspaces_project_id;
DROP INDEX IF EXISTS idx_project_members_project_id;
DROP INDEX IF EXISTS idx_project_members_user_id;

-- Drop tables in reverse order of creation (respecting foreign keys)
DROP TABLE IF EXISTS user_sessions;
DROP TABLE IF EXISTS terminal_history;
DROP TABLE IF EXISTS credentials;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS agent_mcp_servers;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS workspaces;
DROP TABLE IF EXISTS agents;
DROP TABLE IF EXISTS project_invitations;
DROP TABLE IF EXISTS project_members;
DROP TABLE IF EXISTS projects;
DROP TABLE IF EXISTS users;
