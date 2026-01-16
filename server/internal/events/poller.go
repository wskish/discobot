package events

import (
	"context"
	"log"
	"sync"
	"time"

	"github.com/obot-platform/octobot/server/internal/store"
)

// PollerConfig contains configuration for the event poller.
type PollerConfig struct {
	// PollInterval is how often to poll for new events when there are no notifications.
	PollInterval time.Duration
	// BatchSize is the maximum number of events to fetch per poll.
	BatchSize int
}

// DefaultPollerConfig returns the default poller configuration.
func DefaultPollerConfig() PollerConfig {
	return PollerConfig{
		PollInterval: 100 * time.Millisecond,
		BatchSize:    100,
	}
}

// Poller polls the database for new events and broadcasts them to subscribers.
// A single poller handles all projects - subscribers filter by project ID.
type Poller struct {
	store  *store.Store
	config PollerConfig

	// Last seen sequence number
	lastSeq   int64
	lastSeqMu sync.Mutex

	// Subscribers receive all events and filter by project ID
	subscribers   map[string]*Subscriber
	subscribersMu sync.RWMutex
	nextSubID     int

	// Notification channel for immediate polling
	notifyCh chan struct{}

	// Lifecycle management
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// NewPoller creates a new event poller.
func NewPoller(s *store.Store, config PollerConfig) *Poller {
	return &Poller{
		store:       s,
		config:      config,
		subscribers: make(map[string]*Subscriber),
		notifyCh:    make(chan struct{}, 100),
	}
}

// Start begins polling for events.
func (p *Poller) Start(parentCtx context.Context) error {
	p.ctx, p.cancel = context.WithCancel(parentCtx)

	// Initialize last seen sequence from database
	maxSeq, err := p.store.GetMaxEventSeq(p.ctx)
	if err != nil {
		return err
	}
	p.lastSeq = maxSeq

	log.Printf("Event poller starting (last seq: %d)", p.lastSeq)

	// Start polling loop
	p.wg.Add(1)
	go p.pollLoop()

	return nil
}

// Stop gracefully stops the poller.
func (p *Poller) Stop() {
	log.Println("Event poller stopping...")
	p.cancel()

	// Wait for poll loop to finish
	done := make(chan struct{})
	go func() {
		p.wg.Wait()
		close(done)
	}()

	select {
	case <-done:
		log.Println("Event poller stopped")
	case <-time.After(5 * time.Second):
		log.Println("Timeout waiting for event poller to stop")
	}

	// Close all subscribers
	p.subscribersMu.Lock()
	for _, sub := range p.subscribers {
		sub.Close()
	}
	p.subscribers = make(map[string]*Subscriber)
	p.subscribersMu.Unlock()
}

// NotifyNewEvent notifies the poller that a new event was added to the database.
// This triggers immediate polling instead of waiting for the next poll interval.
func (p *Poller) NotifyNewEvent() {
	select {
	case p.notifyCh <- struct{}{}:
	default:
		// Channel full, next poll will pick it up
	}
}

// Subscribe creates a new subscription for events.
// The subscriber receives all events and should filter by project ID.
func (p *Poller) Subscribe(projectID string) *Subscriber {
	p.subscribersMu.Lock()
	defer p.subscribersMu.Unlock()

	p.nextSubID++
	subID := string(rune('a' + (p.nextSubID % 26)))

	sub := &Subscriber{
		ID:        subID,
		ProjectID: projectID,
		Events:    make(chan *Event, 100),
		done:      make(chan struct{}),
	}

	p.subscribers[subID] = sub
	return sub
}

// Unsubscribe removes a subscription.
func (p *Poller) Unsubscribe(sub *Subscriber) {
	p.subscribersMu.Lock()
	defer p.subscribersMu.Unlock()

	delete(p.subscribers, sub.ID)
	sub.Close()
}

// pollLoop continuously polls for new events.
func (p *Poller) pollLoop() {
	defer p.wg.Done()

	ticker := time.NewTicker(p.config.PollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-p.ctx.Done():
			return
		case <-ticker.C:
			p.pollAndBroadcast()
		case <-p.notifyCh:
			p.pollAndBroadcast()
		}
	}
}

// pollAndBroadcast fetches new events and broadcasts them to subscribers.
func (p *Poller) pollAndBroadcast() {
	p.lastSeqMu.Lock()
	afterSeq := p.lastSeq
	p.lastSeqMu.Unlock()

	events, err := p.store.ListEventsAfterSeq(p.ctx, afterSeq, p.config.BatchSize)
	if err != nil {
		log.Printf("Failed to poll events: %v", err)
		return
	}

	if len(events) == 0 {
		return
	}

	// Update last seen sequence
	p.lastSeqMu.Lock()
	p.lastSeq = events[len(events)-1].Seq
	p.lastSeqMu.Unlock()

	// Broadcast events to subscribers
	p.subscribersMu.RLock()
	defer p.subscribersMu.RUnlock()

	for _, dbEvent := range events {
		event := FromModel(&dbEvent)

		for _, sub := range p.subscribers {
			// Only send events matching the subscriber's project
			if sub.ProjectID != dbEvent.ProjectID {
				continue
			}

			sub.mu.Lock()
			if !sub.isClosed {
				select {
				case sub.Events <- event:
				default:
					// Channel full, skip this event for this subscriber
					log.Printf("Event channel full for subscriber %s, dropping event %s", sub.ID, event.ID)
				}
			}
			sub.mu.Unlock()
		}
	}
}

// LastSeq returns the last seen sequence number.
func (p *Poller) LastSeq() int64 {
	p.lastSeqMu.Lock()
	defer p.lastSeqMu.Unlock()
	return p.lastSeq
}
