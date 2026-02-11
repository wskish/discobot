package middleware

import (
	"fmt"
	"net/http"
	"net/url"
	"time"

	"github.com/go-chi/chi/v5/middleware"
)

// SensitiveQueryParams are query parameters that should be redacted in logs
var SensitiveQueryParams = []string{"token", "password", "api_key", "secret", "apiKey"}

// SanitizedLogger is a middleware that logs HTTP requests with sensitive query params redacted
func SanitizedLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		t1 := time.Now()

		defer func() {
			// Redact sensitive query parameters
			sanitizedURL := redactSensitiveParams(r.URL)

			scheme := "http"
			if r.TLS != nil {
				scheme = "https"
			}

			reqID := middleware.GetReqID(r.Context())
			timestamp := time.Now().Format("2006/01/02 15:04:05")
			fmt.Printf("%s [%s] \"%s %s://%s%s %s\" from %s - %d %dB in %v\n",
				timestamp,
				reqID,
				r.Method,
				scheme,
				r.Host,
				sanitizedURL,
				r.Proto,
				r.RemoteAddr,
				ww.Status(),
				ww.BytesWritten(),
				time.Since(t1),
			)
		}()

		next.ServeHTTP(ww, r)
	})
}

// redactSensitiveParams returns a URL string with sensitive query parameters redacted
func redactSensitiveParams(u *url.URL) string {
	if u.RawQuery == "" {
		return u.Path
	}

	query := u.Query()
	hasRedacted := false

	for _, param := range SensitiveQueryParams {
		if query.Has(param) {
			query.Set(param, "[REDACTED]")
			hasRedacted = true
		}
	}

	if !hasRedacted {
		return u.RequestURI()
	}

	return u.Path + "?" + query.Encode()
}
