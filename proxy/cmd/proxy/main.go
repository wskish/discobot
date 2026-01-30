// Package main is the entry point for the proxy server.
package main

import (
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	proxyapi "github.com/obot-platform/discobot/proxy/internal/api"
	"github.com/obot-platform/discobot/proxy/internal/config"
	"github.com/obot-platform/discobot/proxy/internal/logger"
	"github.com/obot-platform/discobot/proxy/internal/proxy"
)

func main() {
	configFile := flag.String("config", "config.yaml", "Path to configuration file")
	flag.Parse()

	// Load configuration
	cfg, err := loadConfig(*configFile)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error loading config: %v\n", err)
		os.Exit(1)
	}

	// Create logger
	log, err := logger.New(cfg.Logging)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error creating logger: %v\n", err)
		os.Exit(1)
	}
	defer func() { _ = log.Close() }()

	// Create proxy server
	proxyServer, err := proxy.New(cfg, log)
	if err != nil {
		log.Error("failed to create proxy server")
		os.Exit(1)
	}

	// Create API server
	apiServer := proxyapi.New(proxyServer, log)

	// Start config file watcher
	watcher := config.NewWatcher(*configFile, func(newCfg *config.Config) {
		log.Info("config reloaded")
		proxyServer.ApplyConfig(newCfg)
	})
	if err := watcher.Start(); err != nil {
		log.Warn("config watcher failed to start")
	} else {
		defer watcher.Stop()
	}

	// Handle shutdown signals
	shutdown := make(chan os.Signal, 1)
	signal.Notify(shutdown, syscall.SIGINT, syscall.SIGTERM)

	// Start API server in goroutine
	go func() {
		addr := fmt.Sprintf(":%d", cfg.Proxy.APIPort)
		if err := apiServer.ListenAndServe(addr); err != nil {
			log.Error("api server error")
		}
	}()

	// Start proxy server in goroutine
	errCh := make(chan error, 1)
	go func() {
		errCh <- proxyServer.ListenAndServe()
	}()

	// Wait for shutdown signal or error
	select {
	case <-shutdown:
		log.Info("shutting down...")
	case err := <-errCh:
		if err != nil {
			log.Error("proxy server error")
		}
	}

	// Graceful shutdown
	if err := proxyServer.Close(); err != nil {
		log.Error("error during shutdown")
	}

	log.Info("shutdown complete")
}

func loadConfig(path string) (*config.Config, error) {
	// Try to load config file
	cfg, err := config.Load(path)
	if err != nil {
		// If file doesn't exist, use defaults
		if os.IsNotExist(err) {
			fmt.Printf("Config file not found, using defaults\n")
			return config.Default(), nil
		}
		return nil, err
	}
	return cfg, nil
}
