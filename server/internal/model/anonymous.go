package model

// Anonymous user constants for no-auth mode.
// These are well-known IDs used when AUTH_ENABLED=false.
const (
	// AnonymousUserID is the reserved user ID for unauthenticated access.
	// This user is created during database seeding when auth is disabled.
	AnonymousUserID = "00000000-0000-0000-0000-000000000001"

	// AnonymousUserEmail is the email for the anonymous user.
	AnonymousUserEmail = "anonymous@local"

	// AnonymousUserName is the display name for the anonymous user.
	AnonymousUserName = "Anonymous User"

	// DefaultProjectID is the reserved project ID for the default project.
	// Created during seeding for the anonymous user.
	DefaultProjectID = "00000000-0000-0000-0000-000000000001"

	// DefaultProjectName is the name of the default project.
	DefaultProjectName = "Default Project"

	// DefaultProjectSlug is the slug for the default project.
	DefaultProjectSlug = "default"
)

// NewAnonymousUser creates the anonymous user model.
func NewAnonymousUser() *User {
	name := AnonymousUserName
	return &User{
		ID:         AnonymousUserID,
		Email:      AnonymousUserEmail,
		Name:       &name,
		Provider:   "local",
		ProviderID: "anonymous",
	}
}

// NewDefaultProject creates the default project model.
func NewDefaultProject() *Project {
	return &Project{
		ID:   DefaultProjectID,
		Name: DefaultProjectName,
		Slug: DefaultProjectSlug,
	}
}
