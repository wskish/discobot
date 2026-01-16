// Package logger provides structured logging for the proxy.
package logger

import (
	"net/http"
	"os"
	"time"

	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"

	"github.com/obot-platform/octobot/proxy/internal/config"
)

// Logger wraps zap.Logger with proxy-specific methods.
type Logger struct {
	zap   *zap.Logger
	sugar *zap.SugaredLogger
}

// New creates a new Logger from configuration.
func New(cfg config.LoggingConfig) (*Logger, error) {
	var level zapcore.Level
	switch cfg.Level {
	case "debug":
		level = zapcore.DebugLevel
	case "info":
		level = zapcore.InfoLevel
	case "warn":
		level = zapcore.WarnLevel
	case "error":
		level = zapcore.ErrorLevel
	default:
		level = zapcore.InfoLevel
	}

	var encoder zapcore.Encoder
	encoderConfig := zap.NewProductionEncoderConfig()
	encoderConfig.TimeKey = "time"
	encoderConfig.EncodeTime = zapcore.ISO8601TimeEncoder

	if cfg.Format == "json" {
		encoder = zapcore.NewJSONEncoder(encoderConfig)
	} else {
		encoderConfig.EncodeLevel = zapcore.CapitalColorLevelEncoder
		encoder = zapcore.NewConsoleEncoder(encoderConfig)
	}

	var output zapcore.WriteSyncer
	if cfg.File != "" {
		file, err := os.OpenFile(cfg.File, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600)
		if err != nil {
			return nil, err
		}
		output = zapcore.AddSync(file)
	} else {
		output = zapcore.AddSync(os.Stdout)
	}

	core := zapcore.NewCore(encoder, output, level)
	zapLogger := zap.New(core)

	return &Logger{
		zap:   zapLogger,
		sugar: zapLogger.Sugar(),
	}, nil
}

// Debug logs a debug message.
func (l *Logger) Debug(msg string, keysAndValues ...interface{}) {
	l.sugar.Debugw(msg, keysAndValues...)
}

// Info logs an info message.
func (l *Logger) Info(msg string, keysAndValues ...interface{}) {
	l.sugar.Infow(msg, keysAndValues...)
}

// Warn logs a warning message.
func (l *Logger) Warn(msg string, keysAndValues ...interface{}) {
	l.sugar.Warnw(msg, keysAndValues...)
}

// Error logs an error message.
func (l *Logger) Error(msg string, keysAndValues ...interface{}) {
	l.sugar.Errorw(msg, keysAndValues...)
}

// LogRequest logs an HTTP request.
func (l *Logger) LogRequest(req *http.Request) {
	l.sugar.Infow("request",
		"method", req.Method,
		"host", req.Host,
		"path", req.URL.Path,
		"proto", req.Proto,
		"remote", req.RemoteAddr,
	)
}

// LogResponse logs an HTTP response.
func (l *Logger) LogResponse(resp *http.Response, req *http.Request, duration time.Duration) {
	l.sugar.Infow("response",
		"method", req.Method,
		"host", req.Host,
		"path", req.URL.Path,
		"status", resp.StatusCode,
		"duration", duration,
		"content_length", resp.ContentLength,
	)
}

// LogSOCKSConnect logs a SOCKS5 connection.
func (l *Logger) LogSOCKSConnect(host string, port int, allowed bool) {
	if allowed {
		l.sugar.Infow("socks_connect",
			"host", host,
			"port", port,
		)
	} else {
		l.sugar.Infow("socks_blocked",
			"host", host,
			"port", port,
		)
	}
}

// LogBlocked logs a blocked request.
func (l *Logger) LogBlocked(host string, reason string) {
	l.sugar.Infow("blocked",
		"host", host,
		"reason", reason,
	)
}

// Close flushes any buffered log entries.
func (l *Logger) Close() error {
	return l.zap.Sync()
}
