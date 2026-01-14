# Store Module

This module provides the data access layer using GORM for database operations.

## Files

| File | Description |
|------|-------------|
| `internal/store/store.go` | Store implementation |
| `internal/model/model.go` | GORM models |
| `internal/database/database.go` | Database connection |

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Store Layer                              │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                     Store Struct                          │  │
│  │  - UserMethods                                           │  │
│  │  - ProjectMethods                                        │  │
│  │  - WorkspaceMethods                                      │  │
│  │  - SessionMethods                                        │  │
│  │  - AgentMethods                                          │  │
│  │  - CredentialMethods                                     │  │
│  │  - JobMethods                                            │  │
│  │  - EventMethods                                          │  │
│  └──────────────────────────────────────────────────────────┘  │
│                           │                                      │
│                           ▼                                      │
│                    GORM (*gorm.DB)                              │
│                           │                                      │
│                           ▼                                      │
│              PostgreSQL / SQLite                                │
└─────────────────────────────────────────────────────────────────┘
```

## Store Structure

```go
type Store struct {
    db *gorm.DB
}

func New(db *gorm.DB) *Store {
    return &Store{db: db}
}
```

## Database Models

### User Models

```go
type User struct {
    ID         string `gorm:"primaryKey"`
    Provider   string
    ProviderID string `gorm:"uniqueIndex:idx_provider_id"`
    Email      string
    Name       string
    CreatedAt  time.Time
    UpdatedAt  time.Time
}

type UserSession struct {
    ID        string `gorm:"primaryKey"`
    UserID    string `gorm:"index"`
    TokenHash string `gorm:"uniqueIndex"`
    ExpiresAt time.Time
    CreatedAt time.Time
}
```

### Project Models

```go
type Project struct {
    ID        string `gorm:"primaryKey"`
    Name      string
    OwnerID   string `gorm:"index"`
    CreatedAt time.Time
    UpdatedAt time.Time
}

type ProjectMember struct {
    ID        string `gorm:"primaryKey"`
    ProjectID string `gorm:"index:idx_project_member"`
    UserID    string `gorm:"index:idx_project_member"`
    Role      string // owner, admin, member
    CreatedAt time.Time
}
```

### Workspace Models

```go
type Workspace struct {
    ID        string `gorm:"primaryKey"`
    ProjectID string `gorm:"index"`
    Name      string
    Path      string
    GitRepo   string
    Status    string // initializing, ready, error
    CreatedAt time.Time
    UpdatedAt time.Time
    Sessions  []Session `gorm:"foreignKey:WorkspaceID"`
}
```

### Session Models

```go
type Session struct {
    ID          string `gorm:"primaryKey"`
    WorkspaceID string `gorm:"index"`
    AgentID     string `gorm:"index"`
    Name        string
    Status      string // initializing, running, closed, error
    ContainerID string
    CreatedAt   time.Time
    UpdatedAt   time.Time
}
```

### Agent Models

```go
type Agent struct {
    ID        string `gorm:"primaryKey"`
    ProjectID string `gorm:"index"`
    Name      string
    Type      string
    Mode      string
    Model     string
    IsDefault bool
    Config    datatypes.JSON // Additional config as JSON
    CreatedAt time.Time
    UpdatedAt time.Time
}

type AgentMCPServer struct {
    ID        string `gorm:"primaryKey"`
    AgentID   string `gorm:"index"`
    Name      string
    Type      string // stdio, http
    Config    datatypes.JSON
}
```

### Credential Model

```go
type Credential struct {
    ID             string `gorm:"primaryKey"`
    ProjectID      string `gorm:"index"`
    Provider       string
    EncryptedValue string
    CreatedAt      time.Time
    UpdatedAt      time.Time
}
```

### Job Model

```go
type Job struct {
    ID        string `gorm:"primaryKey"`
    Type      string `gorm:"index:idx_job_status_type"`
    Status    string `gorm:"index:idx_job_status_type"`
    Payload   datatypes.JSON
    Error     string
    StartedAt *time.Time
    FinishedAt *time.Time
    CreatedAt time.Time
}
```

### Event Model

```go
type ProjectEvent struct {
    ID        uint   `gorm:"primaryKey;autoIncrement"`
    ProjectID string `gorm:"index"`
    Type      string
    Payload   datatypes.JSON
    CreatedAt time.Time
}
```

## Store Methods

### User Methods

```go
func (s *Store) CreateUser(ctx context.Context, user *User) error {
    return s.db.WithContext(ctx).Create(user).Error
}

func (s *Store) GetUser(ctx context.Context, id string) (*User, error) {
    var user User
    err := s.db.WithContext(ctx).First(&user, "id = ?", id).Error
    return &user, err
}

func (s *Store) GetUserByProvider(ctx context.Context, provider, providerID string) (*User, error) {
    var user User
    err := s.db.WithContext(ctx).
        First(&user, "provider = ? AND provider_id = ?", provider, providerID).Error
    return &user, err
}
```

### Workspace Methods

```go
func (s *Store) CreateWorkspace(ctx context.Context, workspace *Workspace) error {
    return s.db.WithContext(ctx).Create(workspace).Error
}

func (s *Store) GetWorkspace(ctx context.Context, id string) (*Workspace, error) {
    var workspace Workspace
    err := s.db.WithContext(ctx).
        Preload("Sessions").
        First(&workspace, "id = ?", id).Error
    return &workspace, err
}

func (s *Store) ListWorkspaces(ctx context.Context, projectID string) ([]Workspace, error) {
    var workspaces []Workspace
    err := s.db.WithContext(ctx).
        Preload("Sessions").
        Where("project_id = ?", projectID).
        Order("created_at DESC").
        Find(&workspaces).Error
    return workspaces, err
}

func (s *Store) UpdateWorkspace(ctx context.Context, id string, updates map[string]any) error {
    return s.db.WithContext(ctx).
        Model(&Workspace{}).
        Where("id = ?", id).
        Updates(updates).Error
}

func (s *Store) DeleteWorkspace(ctx context.Context, id string) error {
    return s.db.WithContext(ctx).Delete(&Workspace{}, "id = ?", id).Error
}
```

### Session Methods

```go
func (s *Store) CreateSession(ctx context.Context, session *Session) error {
    return s.db.WithContext(ctx).Create(session).Error
}

func (s *Store) GetSession(ctx context.Context, id string) (*Session, error) {
    var session Session
    err := s.db.WithContext(ctx).First(&session, "id = ?", id).Error
    return &session, err
}

func (s *Store) UpdateSession(ctx context.Context, id string, updates map[string]any) error {
    return s.db.WithContext(ctx).
        Model(&Session{}).
        Where("id = ?", id).
        Updates(updates).Error
}
```

### Job Methods

```go
func (s *Store) EnqueueJob(ctx context.Context, jobType string, payload any) (*Job, error) {
    payloadJSON, _ := json.Marshal(payload)
    job := &Job{
        ID:      uuid.New().String(),
        Type:    jobType,
        Status:  "pending",
        Payload: payloadJSON,
    }
    return job, s.db.WithContext(ctx).Create(job).Error
}

func (s *Store) DequeueJob(ctx context.Context, jobTypes []string) (*Job, error) {
    var job Job
    err := s.db.WithContext(ctx).
        Where("type IN ? AND status = ?", jobTypes, "pending").
        Order("created_at ASC").
        First(&job).Error
    if err != nil {
        return nil, err
    }

    // Mark as processing
    s.db.Model(&job).Updates(map[string]any{
        "status":     "processing",
        "started_at": time.Now(),
    })

    return &job, nil
}

func (s *Store) CompleteJob(ctx context.Context, id string, err error) error {
    updates := map[string]any{
        "status":      "completed",
        "finished_at": time.Now(),
    }
    if err != nil {
        updates["status"] = "failed"
        updates["error"] = err.Error()
    }
    return s.db.WithContext(ctx).
        Model(&Job{}).
        Where("id = ?", id).
        Updates(updates).Error
}
```

### Event Methods

```go
func (s *Store) CreateEvent(ctx context.Context, event *ProjectEvent) error {
    return s.db.WithContext(ctx).Create(event).Error
}

func (s *Store) GetEventsSince(ctx context.Context, projectID string, sequence uint) ([]ProjectEvent, error) {
    var events []ProjectEvent
    err := s.db.WithContext(ctx).
        Where("project_id = ? AND id > ?", projectID, sequence).
        Order("id ASC").
        Find(&events).Error
    return events, err
}
```

## Database Connection

```go
func Connect(dsn string) *gorm.DB {
    var db *gorm.DB
    var err error

    if strings.HasPrefix(dsn, "postgres") {
        db, err = gorm.Open(postgres.Open(dsn), &gorm.Config{})
    } else {
        db, err = gorm.Open(sqlite.Open(dsn), &gorm.Config{})
    }

    if err != nil {
        log.Fatal("Failed to connect database:", err)
    }

    // Configure connection pool
    sqlDB, _ := db.DB()
    sqlDB.SetMaxOpenConns(25)
    sqlDB.SetMaxIdleConns(5)

    return db
}
```

## Migrations

```go
func Migrate(db *gorm.DB) error {
    return db.AutoMigrate(
        &User{},
        &UserSession{},
        &Project{},
        &ProjectMember{},
        &Workspace{},
        &Session{},
        &Agent{},
        &AgentMCPServer{},
        &Credential{},
        &Job{},
        &ProjectEvent{},
    )
}
```

## Seeding

```go
func Seed(db *gorm.DB) error {
    // Create anonymous user
    anonymousUser := &User{
        ID:       "anonymous",
        Provider: "anonymous",
        Name:     "Anonymous User",
    }
    db.FirstOrCreate(anonymousUser, "id = ?", "anonymous")

    // Create default project
    defaultProject := &Project{
        ID:      "local",
        Name:    "Local Project",
        OwnerID: "anonymous",
    }
    db.FirstOrCreate(defaultProject, "id = ?", "local")

    return nil
}
```

## Error Handling

```go
var ErrNotFound = errors.New("not found")

func (s *Store) GetWorkspace(ctx context.Context, id string) (*Workspace, error) {
    var workspace Workspace
    err := s.db.WithContext(ctx).First(&workspace, "id = ?", id).Error
    if errors.Is(err, gorm.ErrRecordNotFound) {
        return nil, ErrNotFound
    }
    return &workspace, err
}
```

## Testing

```go
func NewMock() *Store {
    db, _ := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
    Migrate(db)
    return New(db)
}

func TestStore_CreateWorkspace(t *testing.T) {
    store := NewMock()

    workspace := &Workspace{
        ID:        "test-1",
        ProjectID: "project-1",
        Name:      "Test",
        Status:    "initializing",
    }

    err := store.CreateWorkspace(context.Background(), workspace)
    assert.NoError(t, err)

    got, err := store.GetWorkspace(context.Background(), "test-1")
    assert.NoError(t, err)
    assert.Equal(t, "Test", got.Name)
}
```
