# Docker Registry Pull Caching

This document explains how to use the proxy's caching feature to dramatically speed up Docker image pulls.

## Overview

The proxy can cache Docker registry responses (blobs and manifests) based on their content-addressable SHA256 digests. Since these digests are immutable, cached content is always valid and can be served indefinitely.

### Benefits

- **Faster pulls**: Subsequent pulls of the same images are served from local cache
- **Reduced bandwidth**: Only unique layers are downloaded from the registry
- **Shared layers**: Multiple images sharing the same base layers benefit from caching
- **No Docker daemon changes**: Works transparently with existing Docker workflows

### What Gets Cached

The proxy caches:
- **Blob layers** (`/v2/.*/blobs/sha256:.*`) - The actual image layer data (largest objects)
- **Manifests by digest** (`/v2/.*/manifests/sha256:.*`) - Image metadata when referenced by SHA256

What is **NOT** cached:
- **Manifests by tag** (`/v2/.*/manifests/latest`) - Tags can change over time
- **Failed responses** - Only successful (2xx) responses are cached
- **Responses with `Cache-Control: no-store`** - Respects cache headers

## Configuration

### Basic Setup

Enable caching in your `config.yaml`:

```yaml
cache:
  enabled: true
  dir: ./cache              # Cache storage directory
  max_size: 21474836480     # 20GB in bytes (adjust based on your needs)
  patterns:                 # Optional: custom patterns (defaults to Docker if omitted)
    - "^/v2/.*/blobs/sha256:.*"
    - "^/v2/.*/manifests/sha256:.*"
```

### Size Planning

Consider your usage when setting `max_size`:

- **Small team (5-10 devs)**: 10-20GB
- **Medium team (20-50 devs)**: 50-100GB
- **Large team (50+ devs)**: 100-500GB

Typical Docker images:
- Small image (Alpine-based): 50-200MB
- Medium image (Ubuntu-based): 500MB-2GB
- Large image (with ML libraries): 2-10GB

### Storage

The cache directory structure:
```
./cache/
├── a1b2c3d4...  # Cache file (SHA256 hash of the URL path)
├── a1b2c3d4...meta  # Metadata file (original key)
├── e5f6g7h8...
└── e5f6g7h8...meta
```

Each entry consists of:
- A data file containing the serialized HTTP response
- A metadata file containing the original cache key

## Usage

### Configure Docker to Use the Proxy

#### Option 1: Environment Variables (Per-Command)

```bash
# Start the proxy
./discobot-proxy

# Use proxy for Docker commands
export HTTP_PROXY=http://localhost:17080
export HTTPS_PROXY=http://localhost:17080

docker pull ubuntu:22.04
```

#### Option 2: Docker Daemon Configuration (Global)

Edit `/etc/docker/daemon.json`:

```json
{
  "proxies": {
    "default": {
      "httpProxy": "http://localhost:17080",
      "httpsProxy": "http://localhost:17080",
      "noProxy": "localhost,127.0.0.1"
    }
  }
}
```

Restart Docker:
```bash
sudo systemctl restart docker
```

### Testing the Cache

First pull (cache miss):
```bash
$ time docker pull ubuntu:22.04
# Downloads from registry, caches layers
# Real time: ~30-60 seconds
```

Second pull (cache hit):
```bash
$ docker rmi ubuntu:22.04  # Remove local image
$ time docker pull ubuntu:22.04
# Served from cache
# Real time: ~5-10 seconds (5-10x faster!)
```

## Monitoring

### Cache Statistics

Get current cache stats via the API:

```bash
curl http://localhost:17081/api/cache/stats
```

Response:
```json
{
  "hits": 150,
  "misses": 25,
  "stores": 25,
  "evictions": 2,
  "errors": 0,
  "current_size": 8589934592,
  "hit_rate": 0.857
}
```

Fields:
- `hits`: Number of successful cache retrievals
- `misses`: Number of cache misses (had to fetch from upstream)
- `stores`: Number of items stored in cache
- `evictions`: Number of items removed due to size limits (LRU)
- `errors`: Number of cache errors
- `current_size`: Total bytes currently cached
- `hit_rate`: Ratio of hits to total requests (hits + misses)

### Cache Headers

Cached responses include these headers:
- `X-Cache: HIT` - Response was served from cache
- `X-Cache-Date` - Timestamp when the response was cached

Original responses will not have these headers.

### Logs

The proxy logs cache operations:

```
INFO  cache hit    path=/v2/library/ubuntu/blobs/sha256:abc123...
INFO  cache miss   path=/v2/library/ubuntu/blobs/sha256:def456...
INFO  cached response    path=/v2/library/ubuntu/blobs/sha256:def456...  size=52428800
```

## Management

### Clear Cache

Clear all cached content:

```bash
curl -X DELETE http://localhost:17081/api/cache
```

Or manually:
```bash
rm -rf ./cache/*
```

### Disable Cache Temporarily

Set `enabled: false` in config and restart, or:

```bash
# Stop proxy
# Edit config.yaml: cache.enabled = false
# Restart proxy
```

## Advanced Configuration

### Custom Patterns

Cache additional registry types:

```yaml
cache:
  enabled: true
  dir: ./cache
  max_size: 21474836480
  patterns:
    # Docker
    - "^/v2/.*/blobs/sha256:.*"
    - "^/v2/.*/manifests/sha256:.*"

    # npm packages (if proxying npm registry)
    - "^/@[^/]+/[^/]+/-/.*\\.tgz$"

    # Generic binary artifacts
    - "^/artifacts/.*\\.(tar\\.gz|zip|jar)$"
```

### Registry-Specific Headers

Inject authentication for private registries:

```yaml
cache:
  enabled: true
  dir: ./cache
  max_size: 21474836480

headers:
  "registry.example.com":
    set:
      "Authorization": "Bearer YOUR_TOKEN_HERE"
  "ghcr.io":
    set:
      "Authorization": "Bearer ghp_YOUR_GITHUB_TOKEN"
```

### Allowlist Specific Registries

Restrict caching to specific registries:

```yaml
cache:
  enabled: true
  dir: ./cache
  max_size: 21474836480

allowlist:
  enabled: true
  domains:
    - "*.docker.io"
    - "registry-1.docker.io"
    - "ghcr.io"
    - "*.gcr.io"
```

## Troubleshooting

### Cache Not Working

1. **Check cache is enabled**: Verify `cache.enabled: true` in config
2. **Check patterns**: Ensure patterns match your registry URLs
3. **Check logs**: Look for "cache hit/miss" messages
4. **Check stats**: `curl http://localhost:17081/api/cache/stats`

### High Miss Rate

- **Different tags**: Pulling `latest` vs specific versions bypasses cache
- **Private registries**: Authentication tokens might affect caching
- **Large team**: More diverse images = lower hit rate initially

### Cache Size Growing Too Fast

- **Reduce max_size**: Set a smaller limit
- **Monitor evictions**: Check stats for `evictions` count
- **Clear old content**: Use the DELETE endpoint to start fresh

### Disk Space Issues

The cache will automatically evict old entries when `max_size` is reached (LRU). If you're hitting disk limits:

1. Reduce `max_size` in config
2. Clear cache: `curl -X DELETE http://localhost:17081/api/cache`
3. Move cache to larger volume: Update `dir` in config

## Performance Tips

1. **Use digest references**: When possible, reference images by digest instead of tag:
   ```bash
   docker pull ubuntu@sha256:abc123...
   ```

2. **Pre-warm cache**: Pull common base images once to populate cache:
   ```bash
   docker pull ubuntu:22.04
   docker pull node:20
   docker pull python:3.11
   ```

3. **Shared base images**: Use common base images across your organization to maximize cache hits

4. **Monitor hit rate**: Aim for >70% hit rate for good caching efficiency

## Example Deployment

Complete configuration for a development team:

```yaml
proxy:
  port: 17080
  api_port: 17081

tls:
  cert_dir: ./certs

cache:
  enabled: true
  dir: /var/cache/discobot-proxy
  max_size: 107374182400  # 100GB

allowlist:
  enabled: true
  domains:
    - "*.docker.io"
    - "registry-1.docker.io"
    - "ghcr.io"
    - "*.gcr.io"

logging:
  level: info
  format: json
  file: /var/log/discobot-proxy.log
```

Team setup:
1. Deploy proxy on shared server
2. Configure Docker daemons on dev machines to use proxy
3. Monitor cache stats via API
4. Adjust `max_size` based on usage patterns

Expected results:
- First pull: Normal speed (cache miss)
- Subsequent pulls: 5-10x faster (cache hit)
- Bandwidth savings: 70-90% reduction for repeated pulls
