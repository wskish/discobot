package service

import (
	"context"
	"log"

	"github.com/obot-platform/discobot/server/internal/events"
	"github.com/obot-platform/discobot/server/internal/model"
	"github.com/obot-platform/discobot/server/internal/sandbox"
	"github.com/obot-platform/discobot/server/internal/store"
)

// SandboxWatcher watches for sandbox state changes and syncs session states.
// It handles cases where sandboxes are modified externally (e.g., Docker
// containers deleted outside of Discobot).
type SandboxWatcher struct {
	provider sandbox.Provider
	store    *store.Store
	broker   *events.Broker
}

// NewSandboxWatcher creates a new sandbox watcher.
func NewSandboxWatcher(provider sandbox.Provider, s *store.Store, broker *events.Broker) *SandboxWatcher {
	return &SandboxWatcher{
		provider: provider,
		store:    s,
		broker:   broker,
	}
}

// Start begins watching for sandbox state changes.
// It blocks until the context is cancelled.
// Events are processed to keep session states in sync with sandbox states.
func (w *SandboxWatcher) Start(ctx context.Context) error {
	eventCh, err := w.provider.Watch(ctx)
	if err != nil {
		return err
	}

	log.Printf("SandboxWatcher: started watching sandbox events")

	for {
		select {
		case <-ctx.Done():
			log.Printf("SandboxWatcher: stopped")
			return ctx.Err()

		case event, ok := <-eventCh:
			if !ok {
				log.Printf("SandboxWatcher: event channel closed")
				return nil
			}
			w.handleEvent(ctx, event)
		}
	}
}

// handleEvent processes a sandbox state change event.
func (w *SandboxWatcher) handleEvent(ctx context.Context, event sandbox.StateEvent) {
	// Get the session to check if it exists and get its project ID
	session, err := w.store.GetSessionByID(ctx, event.SessionID)
	if err != nil {
		// Session doesn't exist - the sandbox is orphaned
		// This can happen if a session was deleted but the sandbox wasn't cleaned up
		log.Printf("SandboxWatcher: session %s not found for sandbox event (status: %s)", event.SessionID, event.Status)
		return
	}

	// Determine the new session status based on the sandbox event
	var newStatus string
	var errMsg *string

	switch event.Status {
	case sandbox.StatusRunning:
		// Sandbox is running - session should be ready
		if session.Status != model.SessionStatusReady {
			newStatus = model.SessionStatusReady
		}

	case sandbox.StatusStopped:
		// Sandbox stopped - update session if it was running or in a transitional state
		if session.Status == model.SessionStatusReady ||
			session.Status == model.SessionStatusInitializing ||
			session.Status == model.SessionStatusCreatingSandbox {
			newStatus = model.SessionStatusStopped
		}

	case sandbox.StatusFailed:
		// Sandbox failed - mark session as error
		if session.Status != model.SessionStatusError {
			newStatus = model.SessionStatusError
			if event.Error != "" {
				msg := "Sandbox failed: " + event.Error
				errMsg = &msg
			}
		}

	case sandbox.StatusRemoved:
		// Sandbox was removed (externally or internally)
		// Mark session as stopped if it was in an active state
		if session.Status == model.SessionStatusReady ||
			session.Status == model.SessionStatusInitializing ||
			session.Status == model.SessionStatusCreatingSandbox {
			newStatus = model.SessionStatusStopped
			log.Printf("SandboxWatcher: sandbox for session %s was removed, marking session as stopped", event.SessionID)
		}

	case sandbox.StatusCreated:
		// Sandbox created but not started - this is an intermediate state
		// No action needed for session

	default:
		log.Printf("SandboxWatcher: unknown sandbox status: %s for session %s", event.Status, event.SessionID)
		return
	}

	// Update session status if needed
	if newStatus != "" {
		log.Printf("SandboxWatcher: updating session %s status from %s to %s", event.SessionID, session.Status, newStatus)

		if err := w.store.UpdateSessionStatus(ctx, event.SessionID, newStatus, errMsg); err != nil {
			log.Printf("SandboxWatcher: failed to update session %s status: %v", event.SessionID, err)
			return
		}

		// Publish session update event
		if w.broker != nil {
			if err := w.broker.PublishSessionUpdated(ctx, session.ProjectID, event.SessionID, newStatus, session.CommitStatus); err != nil {
				log.Printf("SandboxWatcher: failed to publish session update event: %v", err)
			}
		}
	}
}
