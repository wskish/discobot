package providers

import (
	"encoding/json"
	"log"
	"sync"

	"github.com/obot-platform/discobot/server/static"
)

// ModelInfo represents a model with its metadata
type ModelInfo struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Family      string `json:"family,omitempty"`
	Provider    string `json:"provider"` // Set during parsing from provider ID
	Description string `json:"description,omitempty"`
	Reasoning   bool   `json:"reasoning"` // Whether model supports extended thinking
}

// modelsDevData represents the entire models.dev api.json structure
type modelsDevData map[string]providerWithModels

// providerWithModels represents a provider entry with its models
type providerWithModels struct {
	ID     string                   `json:"id"`
	Name   string                   `json:"name"`
	Models map[string]modelMetadata `json:"models"`
}

// modelMetadata represents the raw model data from models.dev
type modelMetadata struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Family    string `json:"family,omitempty"`
	Reasoning bool   `json:"reasoning"`
}

// Cached models data
var (
	modelsOnce    sync.Once
	cachedModels  modelsDevData
	modelsLoadErr error
)

// loadModelsData loads and caches the models.dev data
func loadModelsData() {
	modelsOnce.Do(func() {
		data, err := static.Files.ReadFile("models-dev-api.json")
		if err != nil {
			log.Printf("Warning: Failed to load models-dev-api.json: %v", err)
			modelsLoadErr = err
			return
		}

		if err := json.Unmarshal(data, &cachedModels); err != nil {
			log.Printf("Warning: Failed to parse models-dev-api.json: %v", err)
			modelsLoadErr = err
			return
		}
	})
}

// GetModelsForProviders returns all models for the given provider IDs
func GetModelsForProviders(providerIDs []string) ([]ModelInfo, error) {
	loadModelsData()

	if modelsLoadErr != nil {
		return nil, modelsLoadErr
	}

	// Create a map for fast provider lookup
	providerMap := make(map[string]bool)
	for _, id := range providerIDs {
		providerMap[id] = true
	}

	var models []ModelInfo
	seen := make(map[string]bool) // Deduplicate models by ID

	for providerID, provider := range cachedModels {
		// Skip providers not in the requested list
		if !providerMap[providerID] {
			continue
		}

		// Extract all models for this provider
		for _, modelData := range provider.Models {
			// Create fully qualified model ID: provider-id:model-id
			qualifiedID := providerID + ":" + modelData.ID

			// Skip if we've already seen this model ID
			if seen[qualifiedID] {
				continue
			}
			seen[qualifiedID] = true

			models = append(models, ModelInfo{
				ID:        qualifiedID,
				Name:      modelData.Name,
				Family:    modelData.Family,
				Provider:  provider.Name, // Use provider name, not ID
				Reasoning: modelData.Reasoning,
			})
		}
	}

	return models, nil
}

// GetAllModels returns all models across all providers
func GetAllModels() ([]ModelInfo, error) {
	loadModelsData()

	if modelsLoadErr != nil {
		return nil, modelsLoadErr
	}

	var models []ModelInfo
	seen := make(map[string]bool)

	for providerID, provider := range cachedModels {
		for _, modelData := range provider.Models {
			// Create fully qualified model ID: provider-id:model-id
			qualifiedID := providerID + ":" + modelData.ID

			if seen[qualifiedID] {
				continue
			}
			seen[qualifiedID] = true

			models = append(models, ModelInfo{
				ID:        qualifiedID,
				Name:      modelData.Name,
				Family:    modelData.Family,
				Provider:  provider.Name,
				Reasoning: modelData.Reasoning,
			})
		}
	}

	return models, nil
}
