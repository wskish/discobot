package service

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/obot-platform/octobot/server/internal/model"
	"github.com/obot-platform/octobot/server/internal/store"
)

// ProjectService handles project operations
type ProjectService struct {
	store *store.Store
}

// Project represents a project (for API responses)
type Project struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Slug      string    `json:"slug"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// ProjectMember represents a project member (for API responses)
type ProjectMember struct {
	ID         string     `json:"id"`
	ProjectID  string     `json:"projectId"`
	UserID     string     `json:"userId"`
	Role       string     `json:"role"`
	Email      string     `json:"email"`
	Name       string     `json:"name"`
	AvatarURL  string     `json:"avatarUrl,omitempty"`
	InvitedAt  *time.Time `json:"invitedAt,omitempty"`
	AcceptedAt *time.Time `json:"acceptedAt,omitempty"`
}

// ProjectInvitation represents a project invitation (for API responses)
type ProjectInvitation struct {
	ID        string    `json:"id"`
	ProjectID string    `json:"projectId"`
	Email     string    `json:"email"`
	Role      string    `json:"role"`
	Token     string    `json:"token,omitempty"`
	ExpiresAt time.Time `json:"expiresAt"`
	CreatedAt time.Time `json:"createdAt"`
}

// NewProjectService creates a new project service
func NewProjectService(s *store.Store) *ProjectService {
	return &ProjectService{store: s}
}

// ListProjects returns all projects for a user
func (s *ProjectService) ListProjects(ctx context.Context, userID string) ([]Project, error) {
	rows, err := s.store.ListProjectsByUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	projects := make([]Project, len(rows))
	for i, row := range rows {
		projects[i] = Project{
			ID:        row.ID,
			Name:      row.Name,
			Slug:      row.Slug,
			CreatedAt: row.CreatedAt,
			UpdatedAt: row.UpdatedAt,
		}
	}
	return projects, nil
}

// CreateProject creates a new project and adds the creator as owner
func (s *ProjectService) CreateProject(ctx context.Context, userID, name string) (*Project, error) {
	slug := generateSlug(name)

	// Create project
	project := &model.Project{
		Name: name,
		Slug: slug,
	}
	if err := s.store.CreateProject(ctx, project); err != nil {
		return nil, fmt.Errorf("failed to create project: %w", err)
	}

	// Add creator as owner
	now := time.Now()
	member := &model.ProjectMember{
		ProjectID:  project.ID,
		UserID:     userID,
		Role:       "owner",
		InvitedBy:  &userID,
		InvitedAt:  &now,
		AcceptedAt: &now,
	}
	if err := s.store.CreateProjectMember(ctx, member); err != nil {
		return nil, fmt.Errorf("failed to add owner: %w", err)
	}

	return &Project{
		ID:        project.ID,
		Name:      project.Name,
		Slug:      project.Slug,
		CreatedAt: project.CreatedAt,
		UpdatedAt: project.UpdatedAt,
	}, nil
}

// GetProject returns a project by ID
func (s *ProjectService) GetProject(ctx context.Context, projectID string) (*Project, error) {
	project, err := s.store.GetProjectByID(ctx, projectID)
	if err != nil {
		return nil, err
	}
	return &Project{
		ID:        project.ID,
		Name:      project.Name,
		Slug:      project.Slug,
		CreatedAt: project.CreatedAt,
		UpdatedAt: project.UpdatedAt,
	}, nil
}

// UpdateProject updates a project
func (s *ProjectService) UpdateProject(ctx context.Context, projectID, name string) (*Project, error) {
	project, err := s.store.GetProjectByID(ctx, projectID)
	if err != nil {
		return nil, err
	}
	project.Name = name
	if err := s.store.UpdateProject(ctx, project); err != nil {
		return nil, err
	}
	return &Project{
		ID:        project.ID,
		Name:      project.Name,
		Slug:      project.Slug,
		CreatedAt: project.CreatedAt,
		UpdatedAt: project.UpdatedAt,
	}, nil
}

// DeleteProject deletes a project
func (s *ProjectService) DeleteProject(ctx context.Context, projectID string) error {
	return s.store.DeleteProject(ctx, projectID)
}

// GetMemberRole returns the role of a user in a project
func (s *ProjectService) GetMemberRole(ctx context.Context, projectID, userID string) (string, error) {
	member, err := s.store.GetProjectMember(ctx, projectID, userID)
	if err != nil {
		return "", err
	}
	return member.Role, nil
}

// ListMembers returns all members of a project
func (s *ProjectService) ListMembers(ctx context.Context, projectID string) ([]ProjectMember, error) {
	rows, err := s.store.ListProjectMembers(ctx, projectID)
	if err != nil {
		return nil, err
	}
	members := make([]ProjectMember, len(rows))
	for i, row := range rows {
		member := ProjectMember{
			ID:         row.ID,
			ProjectID:  row.ProjectID,
			UserID:     row.UserID,
			Role:       row.Role,
			InvitedAt:  row.InvitedAt,
			AcceptedAt: row.AcceptedAt,
		}
		// If user is preloaded, add their info
		if row.User != nil {
			member.Email = row.User.Email
			member.Name = ptrToString(row.User.Name)
			member.AvatarURL = ptrToString(row.User.AvatarURL)
		}
		members[i] = member
	}
	return members, nil
}

// CreateInvitation creates a project invitation
func (s *ProjectService) CreateInvitation(ctx context.Context, projectID, inviterID, email, role string) (*ProjectInvitation, error) {
	// Generate token
	tokenBytes := make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		return nil, fmt.Errorf("failed to generate token: %w", err)
	}
	token := hex.EncodeToString(tokenBytes)

	expiresAt := time.Now().Add(7 * 24 * time.Hour) // 7 days

	inv := &model.ProjectInvitation{
		ProjectID: projectID,
		Email:     email,
		Role:      role,
		InvitedBy: &inviterID,
		Token:     token,
		ExpiresAt: expiresAt,
	}
	if err := s.store.CreateInvitation(ctx, inv); err != nil {
		return nil, err
	}
	return &ProjectInvitation{
		ID:        inv.ID,
		ProjectID: inv.ProjectID,
		Email:     inv.Email,
		Role:      inv.Role,
		Token:     inv.Token,
		ExpiresAt: inv.ExpiresAt,
		CreatedAt: inv.CreatedAt,
	}, nil
}

// AcceptInvitation accepts a project invitation
func (s *ProjectService) AcceptInvitation(ctx context.Context, token, userID string) error {
	inv, err := s.store.GetInvitationByToken(ctx, token)
	if err != nil {
		return fmt.Errorf("invitation not found: %w", err)
	}

	if time.Now().After(inv.ExpiresAt) {
		return fmt.Errorf("invitation expired")
	}

	// Add user as member
	now := time.Now()
	member := &model.ProjectMember{
		ProjectID:  inv.ProjectID,
		UserID:     userID,
		Role:       inv.Role,
		InvitedBy:  inv.InvitedBy,
		InvitedAt:  &inv.CreatedAt,
		AcceptedAt: &now,
	}
	if err := s.store.CreateProjectMember(ctx, member); err != nil {
		return fmt.Errorf("failed to add member: %w", err)
	}

	// Delete invitation
	return s.store.DeleteInvitation(ctx, inv.ID)
}

// RemoveMember removes a member from a project
func (s *ProjectService) RemoveMember(ctx context.Context, projectID, userID string) error {
	return s.store.DeleteProjectMember(ctx, projectID, userID)
}

// Helper functions

func generateSlug(name string) string {
	// Convert to lowercase
	slug := strings.ToLower(name)
	// Replace spaces and special chars with hyphens
	reg := regexp.MustCompile(`[^a-z0-9]+`)
	slug = reg.ReplaceAllString(slug, "-")
	// Remove leading/trailing hyphens
	slug = strings.Trim(slug, "-")
	// Add random suffix for uniqueness
	suffix := make([]byte, 4)
	_, _ = rand.Read(suffix)
	return fmt.Sprintf("%s-%s", slug, hex.EncodeToString(suffix))
}
