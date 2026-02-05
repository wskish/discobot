# Stage 1: Build agentfs from source
# Using Alpine-based Rust for musl static linking - produces a fully static binary
FROM rust:alpine AS agentfs-builder

# Install build dependencies for static linking
# openssl-libs-static and xz-static provide static libraries (.a files) on Alpine
RUN apk add --no-cache \
    git \
    pkgconfig \
    musl-dev \
    openssl-dev \
    openssl-libs-static \
    xz-dev \
    xz-static

WORKDIR /build

# Clone agentfs from upstream tursodatabase (PR #271)
RUN git clone https://github.com/tursodatabase/agentfs.git \
    && cd agentfs \
    && git fetch origin pull/271/head:pr-271 \
    && git checkout pr-271

WORKDIR /build/agentfs/cli

# Configure static linking for OpenSSL and LZMA
ENV OPENSSL_STATIC=1
ENV LZMA_API_STATIC=1

# Build with static linking and no sandbox feature (removes libunwind dependency)
# --no-default-features disables the sandbox feature which requires reverie/libunwind
# musl + static OpenSSL/LZMA produces a fully static binary with no runtime dependencies
RUN cargo build --release --no-default-features \
    && cp target/release/agentfs /build/agentfs-bin \
    && strip /build/agentfs-bin

# Stage 2: Build the proxy from source
FROM golang:1.25 AS proxy-builder

WORKDIR /build

# Copy module files first for better caching
COPY go.mod go.sum ./

# Download dependencies
RUN go mod download

# Copy proxy source
COPY proxy/ ./proxy/

# Build the proxy binary
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /proxy ./proxy/cmd/proxy

# Stage 2b: Build the agent init process from source
FROM golang:1.25 AS agent-builder

WORKDIR /build

# Copy module files first for better caching
COPY go.mod go.sum ./

# Download dependencies
RUN go mod download

# Copy agent source (including embedded proxy config)
COPY agent/ ./agent/

# Build the agent binary (static for portability)
# The go:embed directive will include agent/internal/proxy/default-config.yaml
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /discobot-agent ./agent/cmd/agent

# Stage 2c: Extract Claude CLI version from SDK package metadata
# The SDK's package.json contains "claudeCodeVersion" field declaring compatible CLI version
FROM oven/bun:1-alpine AS version-extractor
COPY agent-api/package.json agent-api/bun.lock* /tmp/
WORKDIR /tmp
RUN bun install --frozen-lockfile 2>/dev/null || bun install \
    && CLI_VERSION=$(cat node_modules/@anthropic-ai/claude-agent-sdk/package.json | grep -o '"claudeCodeVersion": "[^"]*"' | cut -d'"' -f4) \
    && echo "$CLI_VERSION" > /cli-version \
    && echo "Claude Code CLI version from SDK: $CLI_VERSION"

# Stage 3: Build the Bun standalone binary (glibc)
FROM oven/bun:1 AS bun-builder

WORKDIR /app

# Copy package files from agent-api directory
COPY agent-api/package.json agent-api/bun.lock* ./

# Install dependencies with Bun
RUN bun install

# Copy source files from agent-api directory
COPY agent-api/tsconfig.json ./
COPY agent-api/src ./src

# Build standalone binary for native architecture (buildx handles multi-arch)
# This binary links against glibc and works on Debian/Ubuntu-based systems
RUN bun build ./src/index.ts \
    --compile \
    --minify \
    --outfile=discobot-agent-api

# Stage 3b: Build the Bun standalone binary (musl)
FROM oven/bun:1-alpine AS bun-builder-musl

WORKDIR /app

# Copy package files from agent-api directory
COPY agent-api/package.json agent-api/bun.lock* ./

# Install dependencies with Bun
RUN bun install

# Copy source files from agent-api directory
COPY agent-api/tsconfig.json ./
COPY agent-api/src ./src

# Build standalone binary for musl-based systems (Alpine Linux)
# This binary links against musl libc and works on Alpine-based systems
RUN bun build ./src/index.ts \
    --compile \
    --minify \
    --outfile=discobot-agent-api.musl

# Stage 4: Minimal Ubuntu runtime
FROM ubuntu:24.04 AS runtime

# Install all apt packages first for better layer caching
# (apt-get changes infrequently; binary copies change with each code change)
# git is needed for workspace cloning
# socat is needed for vsock forwarding in VZ VMs
# fuse3 is needed for agentfs FUSE filesystem
# nodejs is needed for claude-code-acp
# pnpm is needed for package management
# docker.io provides dockerd daemon and docker CLI (runs inside container with privileged mode)
# docker-buildx is needed for multi-arch builds and advanced build features
# iptables is needed by dockerd for network management
# rsync is needed for agentfs to overlayfs migration
# Copy the extracted CLI version from version-extractor stage
COPY --from=version-extractor /cli-version /tmp/cli-version

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    curl \
    docker-buildx \
    docker.io \
    fuse3 \
    git \
    iptables \
    jq \
    openssh-client \
    psmisc \
    rsync \
    socat \
    sqlite3 \
    vim \
    && curl -fsSL https://deb.nodesource.com/setup_25.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    # Install Claude Code CLI with version derived from SDK (0.2.X -> 2.1.X)
    && CLI_VERSION=$(cat /tmp/cli-version) \
    && echo "Installing Claude Code CLI version: $CLI_VERSION" \
    && npm install -g @anthropic-ai/claude-code@${CLI_VERSION} @zed-industries/claude-code-acp pnpm \
    # Install latest stable Go
    && GO_VERSION=$(curl -fsSL 'https://go.dev/VERSION?m=text' | head -1) \
    && curl -fsSL "https://go.dev/dl/${GO_VERSION}.linux-$(dpkg --print-architecture).tar.gz" | tar -C /usr/local -xz \
    && rm -rf /var/lib/apt/lists/* /root/.npm \
    # Enable user_allow_other in fuse.conf (required for --allow-root mount option)
    && echo 'user_allow_other' >> /etc/fuse.conf

# Create discobot user (UID 1000)
# Handle case where UID 1000 might already be taken by another user
RUN (useradd -m -s /bin/bash -u 1000 discobot 2>/dev/null \
        || (userdel -r $(getent passwd 1000 | cut -d: -f1) 2>/dev/null; useradd -m -s /bin/bash -u 1000 discobot) \
        || useradd -m -s /bin/bash discobot)

# Install rustup for discobot user (Rust toolchain manager)
# Must be done after user creation so rust tools are owned by discobot
RUN su - discobot -c 'curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile default'

# Configure npm global directory in /home/discobot/.npm-global
# This allows npm install -g to work without root for the discobot user
# Environment is set system-wide via /etc/profile.d so both root and discobot can use it
RUN mkdir -p /home/discobot/.npm-global/bin \
    && chown -R discobot:discobot /home/discobot/.npm-global \
    && printf '%s\n' \
        '# npm global packages directory' \
        'export NPM_CONFIG_PREFIX="/home/discobot/.npm-global"' \
        'export PATH="/home/discobot/.npm-global/bin:$PATH"' \
        > /etc/profile.d/npm-global.sh \
    && chmod 644 /etc/profile.d/npm-global.sh

# Copy container-specific agent configuration (Claude Code commands, etc.)
# These are placed in /home/discobot/.claude/ for user-level availability
COPY --chown=discobot:discobot container-assets/claude /home/discobot/.claude

# Create directory structure per filesystem design
# /.data      - persistent storage (Docker volume or VZ disk)
# /.workspace - base workspace (read-only)
# /workspace  - project root (writable)
RUN mkdir -p /.data /.workspace /workspace /opt/discobot/bin \
    && chown discobot:discobot /.data /workspace

# Copy binaries to /opt/discobot/bin
# (placed after apt-get so code changes don't invalidate apt cache)
COPY --from=bun-builder /app/discobot-agent-api /opt/discobot/bin/discobot-agent-api
COPY --from=bun-builder-musl /app/discobot-agent-api.musl /opt/discobot/bin/discobot-agent-api.musl
COPY --from=proxy-builder /proxy /opt/discobot/bin/proxy
COPY --from=agent-builder /discobot-agent /opt/discobot/bin/discobot-agent
RUN chmod +x /opt/discobot/bin/*

# Add discobot binaries and npm global bin to PATH
# Also set NPM_CONFIG_PREFIX for non-login shell contexts
# Set PNPM_HOME to use persistent storage for pnpm cache/store
# Add Rust cargo bin for rustc and cargo
# Claude CLI is installed to /usr/local/bin (already in default PATH)
ENV NPM_CONFIG_PREFIX="/home/discobot/.npm-global"
ENV PNPM_HOME="/.data/pnpm"
ENV PATH="/home/discobot/.cargo/bin:/usr/local/go/bin:/home/discobot/.npm-global/bin:/opt/discobot/bin:${PATH}"

WORKDIR /workspace

EXPOSE 3002

# Use discobot-agent as PID 1 init process
# It handles signal forwarding, process reaping, and user switching
# Container starts as root; discobot-agent switches to discobot user for the API
CMD ["/opt/discobot/bin/discobot-agent"]

# Stage 5: VZ disk image builder (non-default target)
# Build with: docker build --target vz-disk-image --output type=local,dest=. .
# This creates a compressed ext4 root filesystem image for macOS Virtualization.framework
FROM ubuntu:24.04 AS vz-disk-image-builder

# Install tools for creating ext4 images
RUN apt-get update && apt-get install -y --no-install-recommends \
    e2fsprogs \
    zstd \
    && rm -rf /var/lib/apt/lists/*

# Copy the entire runtime filesystem
# This captures everything from the runtime stage
COPY --from=runtime / /rootfs

# Prepare rootfs for VM use
RUN set -ex \
    # Create essential mount points (empty dirs)
    && mkdir -p /rootfs/proc /rootfs/sys /rootfs/dev /rootfs/run /rootfs/tmp \
    # Create VirtioFS mount point for metadata
    && mkdir -p /rootfs/run/discobot/metadata \
    # Create simple init script for VZ VMs
    && printf '#!/bin/sh\n\
set -e\n\
\n\
# Mount essential filesystems\n\
mount -t proc proc /proc\n\
mount -t sysfs sysfs /sys\n\
mount -t devtmpfs devtmpfs /dev\n\
mount -t tmpfs tmpfs /tmp\n\
mount -t tmpfs tmpfs /run\n\
\n\
# Mount writable directories as tmpfs (root is read-only)\n\
mount -t tmpfs tmpfs /data\n\
mount -t tmpfs tmpfs /workspace\n\
mount -t tmpfs tmpfs /home/discobot\n\
\n\
# Mount VirtioFS metadata (shared from host)\n\
mkdir -p /run/discobot/metadata\n\
mount -t virtiofs discobot-meta /run/discobot/metadata 2>/dev/null || true\n\
\n\
# Mount persistent data disk at /.data\n\
mount -t virtiofs discobot-data /.data 2>/dev/null || true\n\
\n\
# Mount workspace from host at /.workspace (read-only)\n\
mount -t virtiofs discobot-workspace /.workspace 2>/dev/null || true\n\
\n\
# Start the agent (discobot-agent handles user switching and process reaping)\n\
cd /workspace\n\
exec /opt/discobot/bin/discobot-agent\n\
' > /rootfs/init \
    && chmod +x /rootfs/init

# Create the ext4 disk image using mkfs.ext4 -d (no mount required)
# Size: 2GB (enough for Ubuntu base + agent + dependencies)
RUN set -ex \
    # Create ext4 image directly from directory
    # -d populates from directory without needing loop mount
    && mkfs.ext4 -F -L rootfs -O ^has_journal -d /rootfs -r 0 /disk.img 2G \
    # Compress with zstd (good compression ratio and fast decompression)
    && zstd -19 --rm /disk.img -o /disk.img.zst

# Final stage for VZ: just the compressed disk image
FROM scratch AS vz-disk-image
COPY --from=vz-disk-image-builder /disk.img.zst /discobot-rootfs.img.zst

# Stage 6: Linux kernel builder for VZ
# Build with: docker build --target vz-kernel --output type=local,dest=. .
# This builds a minimal Linux kernel with virtio support for macOS Virtualization.framework
FROM ubuntu:24.04 AS vz-kernel-builder

# Install kernel build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    bc \
    bison \
    flex \
    libelf-dev \
    libssl-dev \
    libncurses-dev \
    ca-certificates \
    curl \
    jq \
    xz-utils \
    zstd \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Download latest stable kernel from kernel.org
# Uses the releases.json API to find the latest stable version
RUN set -ex \
    && KERNEL_VERSION=$(curl -s https://www.kernel.org/releases.json | jq -r '[.releases[] | select(.moniker == "stable")][0].version') \
    && echo "Found kernel version: ${KERNEL_VERSION}" \
    && KERNEL_MAJOR=$(echo $KERNEL_VERSION | cut -d. -f1) \
    && echo "Downloading Linux kernel ${KERNEL_VERSION}..." \
    && curl -fSL "https://cdn.kernel.org/pub/linux/kernel/v${KERNEL_MAJOR}.x/linux-${KERNEL_VERSION}.tar.xz" -o linux.tar.xz \
    && tar -xf linux.tar.xz --strip-components=1 \
    && rm linux.tar.xz \
    && echo "$KERNEL_VERSION" > /kernel-version

# Create minimal kernel config for VZ VMs
# Start with tinyconfig and add required features
RUN set -ex \
    && make tinyconfig \
    # Enable 64-bit support
    && ./scripts/config --enable CONFIG_64BIT \
    # Basic kernel features
    && ./scripts/config --enable CONFIG_PRINTK \
    && ./scripts/config --enable CONFIG_BUG \
    && ./scripts/config --enable CONFIG_MULTIUSER \
    && ./scripts/config --enable CONFIG_SHMEM \
    && ./scripts/config --enable CONFIG_TMPFS \
    && ./scripts/config --enable CONFIG_PROC_FS \
    && ./scripts/config --enable CONFIG_SYSFS \
    && ./scripts/config --enable CONFIG_DEVTMPFS \
    && ./scripts/config --enable CONFIG_DEVTMPFS_MOUNT \
    # TTY/Console support
    && ./scripts/config --enable CONFIG_TTY \
    && ./scripts/config --enable CONFIG_VT \
    && ./scripts/config --enable CONFIG_UNIX98_PTYS \
    && ./scripts/config --enable CONFIG_SERIAL_8250 \
    && ./scripts/config --enable CONFIG_SERIAL_8250_CONSOLE \
    # Block device support
    && ./scripts/config --enable CONFIG_BLOCK \
    && ./scripts/config --enable CONFIG_BLK_DEV \
    # EXT4 filesystem (built-in, not module)
    && ./scripts/config --enable CONFIG_EXT4_FS \
    && ./scripts/config --enable CONFIG_EXT4_USE_FOR_EXT2 \
    # PCI support (needed for virtio-pci)
    && ./scripts/config --enable CONFIG_PCI \
    && ./scripts/config --enable CONFIG_PCI_HOST_GENERIC \
    # Virtio support (all built-in for simple boot)
    && ./scripts/config --enable CONFIG_VIRTIO \
    && ./scripts/config --enable CONFIG_VIRTIO_MENU \
    && ./scripts/config --enable CONFIG_VIRTIO_PCI \
    && ./scripts/config --enable CONFIG_VIRTIO_PCI_LEGACY \
    && ./scripts/config --enable CONFIG_VIRTIO_MMIO \
    && ./scripts/config --enable CONFIG_VIRTIO_BLK \
    && ./scripts/config --enable CONFIG_VIRTIO_NET \
    && ./scripts/config --enable CONFIG_VIRTIO_CONSOLE \
    && ./scripts/config --enable CONFIG_HW_RANDOM_VIRTIO \
    # VirtioFS support
    && ./scripts/config --enable CONFIG_FUSE_FS \
    && ./scripts/config --enable CONFIG_VIRTIO_FS \
    # Vsock support
    && ./scripts/config --enable CONFIG_VSOCKETS \
    && ./scripts/config --enable CONFIG_VIRTIO_VSOCKETS \
    # Networking basics
    && ./scripts/config --enable CONFIG_NET \
    && ./scripts/config --enable CONFIG_INET \
    && ./scripts/config --enable CONFIG_NETDEVICES \
    # Init and executable support
    && ./scripts/config --enable CONFIG_BINFMT_ELF \
    && ./scripts/config --enable CONFIG_BINFMT_SCRIPT \
    # Disable unnecessary features
    && ./scripts/config --disable CONFIG_MODULES \
    && ./scripts/config --disable CONFIG_SWAP \
    && ./scripts/config --disable CONFIG_SUSPEND \
    && ./scripts/config --disable CONFIG_HIBERNATION \
    # Set init path
    && ./scripts/config --set-str CONFIG_DEFAULT_INIT "/init" \
    # Update config to resolve dependencies
    && make olddefconfig

# Build the kernel
# Use all available cores for faster build
# Target varies by architecture: bzImage for x86, Image for arm64
RUN ARCH=$(uname -m) \
    && if [ "$ARCH" = "x86_64" ]; then \
         make -j$(nproc) bzImage; \
       elif [ "$ARCH" = "aarch64" ]; then \
         make -j$(nproc) Image; \
       else \
         make -j$(nproc); \
       fi

# Copy the kernel image and version info
RUN ARCH=$(uname -m) \
    && if [ "$ARCH" = "x86_64" ]; then \
         cp arch/x86/boot/bzImage /vmlinuz; \
       elif [ "$ARCH" = "aarch64" ]; then \
         cp arch/arm64/boot/Image /vmlinuz; \
       else \
         echo "Unsupported architecture: $ARCH" && exit 1; \
       fi \
    && zstd -19 /vmlinuz -o /vmlinuz.zst

# Final stage for kernel: just the compressed kernel
FROM scratch AS vz-kernel
COPY --from=vz-kernel-builder /vmlinuz.zst /vmlinuz.zst
COPY --from=vz-kernel-builder /kernel-version /kernel-version

# Default target: runtime image
FROM runtime
