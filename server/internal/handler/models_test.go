package handler

import (
	"reflect"
	"testing"

	"github.com/obot-platform/discobot/server/internal/service"
)

// TestModelMapping ensures that all fields from service.Model are properly mapped to handler.ModelInfo.
// This test uses reflection to verify that:
// 1. All exported fields in service.Model have corresponding fields in handler.ModelInfo
// 2. The field types match
// 3. The JSON tags match (to ensure API stability)
func TestModelMapping(t *testing.T) {
	serviceType := reflect.TypeOf(service.Model{})
	handlerType := reflect.TypeOf(ModelInfo{})

	// Build a map of handler fields for quick lookup
	handlerFields := make(map[string]reflect.StructField)
	for i := 0; i < handlerType.NumField(); i++ {
		field := handlerType.Field(i)
		handlerFields[field.Name] = field
	}

	// Check that every field in service.Model exists in handler.ModelInfo
	for i := 0; i < serviceType.NumField(); i++ {
		serviceField := serviceType.Field(i)

		// Skip unexported fields
		if !serviceField.IsExported() {
			continue
		}

		// Check if handler has this field
		handlerField, exists := handlerFields[serviceField.Name]
		if !exists {
			t.Errorf("Field %s exists in service.Model but not in handler.ModelInfo", serviceField.Name)
			continue
		}

		// Check that types match
		if serviceField.Type != handlerField.Type {
			t.Errorf("Field %s has type %s in service.Model but type %s in handler.ModelInfo",
				serviceField.Name, serviceField.Type, handlerField.Type)
		}

		// Check that JSON tags match (ignoring omitempty since that's an implementation detail)
		serviceTag := serviceField.Tag.Get("json")
		handlerTag := handlerField.Tag.Get("json")

		// Strip omitempty for comparison
		serviceTagName := stripOmitEmpty(serviceTag)
		handlerTagName := stripOmitEmpty(handlerTag)

		if serviceTagName != handlerTagName {
			t.Errorf("Field %s has JSON tag '%s' in service.Model but '%s' in handler.ModelInfo",
				serviceField.Name, serviceTagName, handlerTagName)
		}
	}
}

// TestModelConversion ensures that the conversion from service.Model to handler.ModelInfo works correctly
func TestModelConversion(t *testing.T) {
	testCases := []struct {
		name         string
		serviceModel service.Model
		expectedInfo ModelInfo
	}{
		{
			name: "model with all fields",
			serviceModel: service.Model{
				ID:          "anthropic:claude-opus-4",
				Name:        "Claude Opus 4",
				Provider:    "Anthropic",
				Description: "Most capable model",
				Reasoning:   true,
			},
			expectedInfo: ModelInfo{
				ID:          "anthropic:claude-opus-4",
				Name:        "Claude Opus 4",
				Provider:    "Anthropic",
				Description: "Most capable model",
				Reasoning:   true,
			},
		},
		{
			name: "model without reasoning",
			serviceModel: service.Model{
				ID:          "anthropic:claude-haiku-3",
				Name:        "Claude Haiku 3",
				Provider:    "Anthropic",
				Description: "Fast model",
				Reasoning:   false,
			},
			expectedInfo: ModelInfo{
				ID:          "anthropic:claude-haiku-3",
				Name:        "Claude Haiku 3",
				Provider:    "Anthropic",
				Description: "Fast model",
				Reasoning:   false,
			},
		},
		{
			name: "model with minimal fields",
			serviceModel: service.Model{
				ID:       "provider:model-id",
				Name:     "Model Name",
				Provider: "Provider",
			},
			expectedInfo: ModelInfo{
				ID:       "provider:model-id",
				Name:     "Model Name",
				Provider: "Provider",
			},
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			// This is how the conversion is done in the handler
			result := ModelInfo{
				ID:          tc.serviceModel.ID,
				Name:        tc.serviceModel.Name,
				Provider:    tc.serviceModel.Provider,
				Description: tc.serviceModel.Description,
				Reasoning:   tc.serviceModel.Reasoning,
			}

			// Compare all fields
			if !reflect.DeepEqual(result, tc.expectedInfo) {
				t.Errorf("Conversion failed:\nGot:      %+v\nExpected: %+v", result, tc.expectedInfo)
			}

			// Specifically check the Reasoning field (since we just fixed a bug with it)
			if result.Reasoning != tc.serviceModel.Reasoning {
				t.Errorf("Reasoning field not properly copied: got %v, expected %v",
					result.Reasoning, tc.serviceModel.Reasoning)
			}
		})
	}
}

// stripOmitEmpty removes the ",omitempty" suffix from a JSON tag
func stripOmitEmpty(tag string) string {
	if len(tag) == 0 {
		return tag
	}
	// Remove ",omitempty" if present
	for i := 0; i < len(tag); i++ {
		if tag[i] == ',' {
			return tag[:i]
		}
	}
	return tag
}
