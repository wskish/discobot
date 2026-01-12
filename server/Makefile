.PHONY: build run dev test clean migrate sqlc help

# Build the server binary
build:
	go build -o bin/server ./cmd/server

# Run the server
run: build
	./bin/server

# Development mode with hot reload (requires air: go install github.com/air-verse/air@latest)
dev:
	air

# Run tests
test:
	go test -v ./...

# Clean build artifacts
clean:
	rm -rf bin/
	rm -f octobot.db

# Generate sqlc code
sqlc:
	sqlc generate

# Run database migrations (server does this on startup, but can also be done manually)
migrate: build
	./bin/server --migrate-only

# Generate a new encryption key
gen-key:
	@openssl rand -hex 32

# Generate a new session secret
gen-secret:
	@openssl rand -hex 32

# Format code
fmt:
	go fmt ./...

# Lint code (requires golangci-lint)
lint:
	golangci-lint run

# Download dependencies
deps:
	go mod download
	go mod tidy

# Help
help:
	@echo "Available targets:"
	@echo "  build      - Build the server binary"
	@echo "  run        - Build and run the server"
	@echo "  dev        - Run with hot reload (requires air)"
	@echo "  test       - Run tests"
	@echo "  clean      - Remove build artifacts"
	@echo "  sqlc       - Generate sqlc code"
	@echo "  migrate    - Run database migrations"
	@echo "  gen-key    - Generate a new encryption key"
	@echo "  gen-secret - Generate a new session secret"
	@echo "  fmt        - Format code"
	@echo "  lint       - Lint code"
	@echo "  deps       - Download and tidy dependencies"
