package service

import (
	"context"
	"fmt"
	"time"

	"github.com/anthropics/octobot/server/internal/model"
	"github.com/anthropics/octobot/server/internal/store"
)

// Session represents a chat session (for API responses)
type Session struct {
	ID          string     `json:"id"`
	Name        string     `json:"name"`
	Description string     `json:"description"`
	Timestamp   string     `json:"timestamp"`
	Status      string     `json:"status"`
	Files       []FileNode `json:"files"`
	WorkspaceID string     `json:"workspaceId,omitempty"`
	AgentID     string     `json:"agentId,omitempty"`
}

// FileNode represents a file in a session
type FileNode struct {
	ID              string     `json:"id"`
	Name            string     `json:"name"`
	Type            string     `json:"type"`
	Children        []FileNode `json:"children,omitempty"`
	Content         string     `json:"content,omitempty"`
	OriginalContent string     `json:"originalContent,omitempty"`
	Changed         bool       `json:"changed,omitempty"`
}

// SessionService handles session operations
type SessionService struct {
	store *store.Store
}

// NewSessionService creates a new session service
func NewSessionService(s *store.Store) *SessionService {
	return &SessionService{store: s}
}

// ListSessionsByWorkspace returns all sessions for a workspace
func (s *SessionService) ListSessionsByWorkspace(ctx context.Context, workspaceID string) ([]*Session, error) {
	dbSessions, err := s.store.ListSessionsByWorkspace(ctx, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("failed to list sessions: %w", err)
	}

	sessions := make([]*Session, len(dbSessions))
	for i, sess := range dbSessions {
		sessions[i] = s.mapSession(sess)
	}
	return sessions, nil
}

// GetSession returns a session by ID
func (s *SessionService) GetSession(ctx context.Context, sessionID string) (*Session, error) {
	sess, err := s.store.GetSessionByID(ctx, sessionID)
	if err != nil {
		return nil, fmt.Errorf("failed to get session: %w", err)
	}

	return s.mapSession(sess), nil
}

// CreateSession creates a new session
func (s *SessionService) CreateSession(ctx context.Context, workspaceID, name, agentID string) (*Session, error) {
	var aidPtr *string
	if agentID != "" {
		aidPtr = &agentID
	}

	sess := &model.Session{
		WorkspaceID: workspaceID,
		AgentID:     aidPtr,
		Name:        name,
		Description: nil,
		Status:      "open",
	}
	if err := s.store.CreateSession(ctx, sess); err != nil {
		return nil, fmt.Errorf("failed to create session: %w", err)
	}

	return s.mapSession(sess), nil
}

// UpdateSession updates a session
func (s *SessionService) UpdateSession(ctx context.Context, sessionID, name, status string) (*Session, error) {
	sess, err := s.store.GetSessionByID(ctx, sessionID)
	if err != nil {
		return nil, fmt.Errorf("failed to get session: %w", err)
	}

	sess.Name = name
	sess.Status = status
	if err := s.store.UpdateSession(ctx, sess); err != nil {
		return nil, fmt.Errorf("failed to update session: %w", err)
	}

	return s.mapSession(sess), nil
}

// DeleteSession deletes a session
func (s *SessionService) DeleteSession(ctx context.Context, sessionID string) error {
	return s.store.DeleteSession(ctx, sessionID)
}

// mapSession maps a model Session to a service Session
func (s *SessionService) mapSession(sess *model.Session) *Session {
	agentID := ""
	if sess.AgentID != nil {
		agentID = *sess.AgentID
	}

	description := ""
	if sess.Description != nil {
		description = *sess.Description
	}

	timestamp := sess.UpdatedAt.Format(time.RFC3339)
	if sess.UpdatedAt.IsZero() {
		timestamp = time.Now().Format(time.RFC3339)
	}

	return &Session{
		ID:          sess.ID,
		Name:        sess.Name,
		Description: description,
		Timestamp:   timestamp,
		Status:      sess.Status,
		Files:       []FileNode{},
		WorkspaceID: sess.WorkspaceID,
		AgentID:     agentID,
	}
}
