package database

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/glebarez/sqlite" // Pure Go SQLite driver (uses modernc.org/sqlite)
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"github.com/obot-platform/discobot/server/internal/config"
	"github.com/obot-platform/discobot/server/internal/model"
)

// DB wraps the GORM DB connection with additional context
type DB struct {
	*gorm.DB
	Driver string
}

// New creates a new database connection based on configuration
func New(cfg *config.Config) (*DB, error) {
	var db *gorm.DB
	var err error

	// Configure logger to only log slow queries (>1 second)
	slowLogger := logger.New(
		log.New(os.Stdout, "\r\n", log.LstdFlags),
		logger.Config{
			SlowThreshold:             time.Second, // Log queries slower than 1 second
			LogLevel:                  logger.Warn, // Only log warnings and errors
			IgnoreRecordNotFoundError: true,        // Don't log "record not found" as error
			Colorful:                  true,
		},
	)

	gormConfig := &gorm.Config{
		Logger: slowLogger,
	}

	driver := cfg.DatabaseDriver
	dsn := cfg.CleanDSN()

	switch driver {
	case "postgres":
		db, err = gorm.Open(postgres.Open(dsn), gormConfig)
	case "sqlite":
		// For SQLite, we need to handle the DSN differently
		// Remove "file:" prefix if present
		sqliteDSN := strings.TrimPrefix(dsn, "file:")
		// glebarez/sqlite (modernc) handles pragmas differently
		// For in-memory databases, use ":memory:"
		// For file databases, just use the path

		// Ensure parent directory exists for file-based databases
		if sqliteDSN != ":memory:" && !strings.HasPrefix(sqliteDSN, ":memory:") {
			dir := filepath.Dir(sqliteDSN)
			if err := os.MkdirAll(dir, 0755); err != nil {
				return nil, fmt.Errorf("failed to create database directory %s: %w", dir, err)
			}
		}

		db, err = gorm.Open(sqlite.Open(sqliteDSN), gormConfig)
		if err == nil {
			// WAL mode allows concurrent readers while a writer is active,
			// preventing connection starvation with multiple goroutines.
			db.Exec("PRAGMA journal_mode=WAL")
			// busy_timeout makes SQLite wait (up to 5s) when the DB is locked
			// instead of immediately returning SQLITE_BUSY.
			db.Exec("PRAGMA busy_timeout = 5000")
			db.Exec("PRAGMA foreign_keys = ON")
		}
	default:
		return nil, fmt.Errorf("unsupported database driver: %s", driver)
	}

	if err != nil {
		return nil, fmt.Errorf("failed to connect to database: %w", err)
	}

	// Get underlying sql.DB for connection pool configuration
	sqlDB, err := db.DB()
	if err != nil {
		return nil, fmt.Errorf("failed to get underlying sql.DB: %w", err)
	}

	// Configure connection pool based on driver
	if driver == "sqlite" {
		// With WAL mode, SQLite supports concurrent readers alongside a single
		// writer. Allow multiple connections so read-heavy polling goroutines
		// don't block behind writes (or each other).
		sqlDB.SetMaxOpenConns(4)
		sqlDB.SetMaxIdleConns(4)
	} else {
		// PostgreSQL handles connection pooling well
		sqlDB.SetMaxOpenConns(25)
		sqlDB.SetMaxIdleConns(5)
	}

	return &DB{DB: db, Driver: driver}, nil
}

// Migrate runs database migrations using GORM's AutoMigrate
func (db *DB) Migrate() error {
	log.Println("Running GORM AutoMigrate...")

	// First run AutoMigrate to add new columns/tables
	if err := db.AutoMigrate(model.AllModels()...); err != nil {
		return err
	}

	// Drop obsolete columns that are no longer in the model
	// Note: AutoMigrate only adds columns, it never removes them
	migrator := db.Migrator()

	// Drop obsolete Agent columns (removed when simplifying agent configuration)
	// SQLite's column drop rebuilds the table (DROP + CREATE), which fails when
	// other tables have foreign key constraints referencing agents. Temporarily
	// disable foreign key enforcement during the migration.
	obsoleteAgentCols := []string{"name", "description", "system_prompt"}
	var colsToDrop []string
	for _, col := range obsoleteAgentCols {
		if migrator.HasColumn(&model.Agent{}, col) {
			colsToDrop = append(colsToDrop, col)
		}
	}
	if len(colsToDrop) > 0 {
		if db.IsSQLite() {
			db.Exec("PRAGMA foreign_keys = OFF")
		}
		for _, col := range colsToDrop {
			log.Printf("Dropping obsolete Agent.%s column...\n", col)
			if err := migrator.DropColumn(&model.Agent{}, col); err != nil {
				if db.IsSQLite() {
					db.Exec("PRAGMA foreign_keys = ON")
				}
				return fmt.Errorf("failed to drop Agent.%s: %w", col, err)
			}
		}
		if db.IsSQLite() {
			db.Exec("PRAGMA foreign_keys = ON")
		}
	}

	return nil
}

// Seed creates the anonymous user and default project for no-auth mode.
// This is idempotent - it will not create duplicates if called multiple times.
func (db *DB) Seed() error {
	log.Println("Seeding database with anonymous user and default project...")

	// Create anonymous user if not exists
	anonUser := model.NewAnonymousUser()
	result := db.DB.Where("id = ?", model.AnonymousUserID).FirstOrCreate(anonUser)
	if result.Error != nil {
		return fmt.Errorf("failed to create anonymous user: %w", result.Error)
	}
	if result.RowsAffected > 0 {
		log.Println("Created anonymous user")
	}

	// Create default project if not exists
	defaultProject := model.NewDefaultProject()
	result = db.DB.Where("id = ?", model.DefaultProjectID).FirstOrCreate(defaultProject)
	if result.Error != nil {
		return fmt.Errorf("failed to create default project: %w", result.Error)
	}
	if result.RowsAffected > 0 {
		log.Println("Created default project")
	}

	// Create project membership for anonymous user if not exists
	membership := &model.ProjectMember{
		ProjectID: model.DefaultProjectID,
		UserID:    model.AnonymousUserID,
		Role:      "owner",
	}
	result = db.DB.Where("project_id = ? AND user_id = ?", model.DefaultProjectID, model.AnonymousUserID).FirstOrCreate(membership)
	if result.Error != nil {
		return fmt.Errorf("failed to create project membership: %w", result.Error)
	}
	if result.RowsAffected > 0 {
		log.Println("Added anonymous user to default project")
	}

	log.Println("Database seeding completed")
	return nil
}

// IsPostgres returns true if using PostgreSQL
func (db *DB) IsPostgres() bool {
	return db.Driver == "postgres"
}

// IsSQLite returns true if using SQLite
func (db *DB) IsSQLite() bool {
	return db.Driver == "sqlite"
}

// Close closes the database connection
func (db *DB) Close() error {
	sqlDB, err := db.DB.DB()
	if err != nil {
		return err
	}
	return sqlDB.Close()
}
