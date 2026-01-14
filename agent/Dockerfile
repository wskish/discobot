# Stage 1: Build agentfs from source
# Using Debian-based Rust for simpler glibc build - multi-arch compatible
FROM rust:slim AS agentfs-builder

# Install build dependencies
RUN apt-get update && apt-get install -y \
    git \
    pkg-config \
    libssl-dev \
    liblzma-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Clone agentfs
RUN git clone https://github.com/tursodatabase/agentfs.git

WORKDIR /build/agentfs/cli

# Build for native architecture (buildx handles multi-arch)
# agentfs uses nightly via rust-toolchain.toml which will be auto-detected
RUN cargo build --release --no-default-features \
    && cp target/release/agentfs /build/agentfs-bin \
    && strip /build/agentfs-bin

# Stage 2: Build the Bun standalone binary
FROM oven/bun:1 AS bun-builder

WORKDIR /app

# Copy package files
COPY package.json bun.lock* ./

# Install dependencies with Bun
RUN bun install

# Copy source files
COPY tsconfig.json ./
COPY src ./src

# Build standalone binary for native architecture (buildx handles multi-arch)
RUN bun build ./src/index.ts \
    --compile \
    --minify \
    --outfile=octobot-agent

# Stage 3: Minimal Ubuntu runtime
FROM ubuntu:24.04

# Install only essential runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user (handle case where UID 1000 already exists)
RUN useradd -m -s /bin/bash -u 1000 octobot 2>/dev/null \
    || (userdel -r $(getent passwd 1000 | cut -d: -f1) 2>/dev/null; useradd -m -s /bin/bash -u 1000 octobot) \
    || useradd -m -s /bin/bash octobot

WORKDIR /app

# Copy the standalone Bun binary
COPY --from=bun-builder /app/octobot-agent ./octobot-agent
RUN chmod +x ./octobot-agent

# Copy agentfs binary
COPY --from=agentfs-builder /build/agentfs-bin /usr/local/bin/agentfs
RUN chmod +x /usr/local/bin/agentfs

# Install claude-code-acp
# We need Node.js for this npm package - install minimal Node runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    nodejs \
    npm \
    && npm install -g @zed-industries/claude-code-acp \
    && apt-get purge -y npm \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/* /root/.npm

# Set ownership
RUN chown -R octobot:octobot /app

USER octobot

EXPOSE 3001

CMD ["./octobot-agent"]
