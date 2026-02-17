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
FROM oven/bun:1.3.9-alpine AS version-extractor
COPY agent-api/package.json agent-api/bun.lock* /tmp/
WORKDIR /tmp
RUN bun install --frozen-lockfile 2>/dev/null || bun install \
    && CLI_VERSION=$(cat node_modules/@anthropic-ai/claude-agent-sdk/package.json | grep -o '"claudeCodeVersion": "[^"]*"' | cut -d'"' -f4) \
    && echo "$CLI_VERSION" > /cli-version \
    && echo "Claude Code CLI version from SDK: $CLI_VERSION"

# Stage 3: Build the Bun standalone binary (glibc)
FROM oven/bun:1.3.9 AS bun-builder

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

# Stage 4: Minimal Ubuntu runtime
FROM ubuntu:24.04 AS runtime

# Label for image identification and cleanup
LABEL io.discobot.sandbox-image=true

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
# systemd is the init system (PID 1) for service management inside the container
# Copy the extracted CLI version from version-extractor stage
COPY --from=version-extractor /cli-version /tmp/cli-version

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && sed -i 's|http://|https://|g' /etc/apt/sources.list.d/ubuntu.sources \
    && apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    docker-buildx \
    docker.io \
    fuse3 \
    git \
    iptables \
    jq \
    openssh-client \
    openssh-sftp-server \
    psmisc \
    python3 \
    python3-pip \
    rsync \
    socat \
    sqlite3 \
    systemd \
    systemd-sysv \
    vim \
    && curl -fsSL https://deb.nodesource.com/setup_25.x | bash - \
    && sed -i 's|http://|https://|g' /etc/apt/sources.list.d/nodesource.list 2>/dev/null || true \
    && apt-get install -y --no-install-recommends nodejs \
    # Install Claude Code CLI with version derived from SDK (0.2.X -> 2.1.X)
    && CLI_VERSION=$(cat /tmp/cli-version) \
    && echo "Installing Claude Code CLI version: $CLI_VERSION" \
    && npm install -g @anthropic-ai/claude-code@${CLI_VERSION} @zed-industries/claude-code-acp pnpm \
    # Install latest stable Go
    && GO_VERSION=$(curl -fsSL 'https://go.dev/VERSION?m=text' | head -1) \
    && curl -fsSL "https://go.dev/dl/${GO_VERSION}.linux-$(dpkg --print-architecture).tar.gz" | tar -C /usr/local -xz \
    # Install uv (Python package installer) to /usr/local/bin
    && curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh \
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
# Install rustup without any toolchains (users can install toolchains on demand with rustup install)
RUN su - discobot -c 'curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain none'

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
COPY --from=proxy-builder /proxy /opt/discobot/bin/proxy
COPY --from=agent-builder /discobot-agent /opt/discobot/bin/discobot-agent
RUN chmod +x /opt/discobot/bin/*

# Copy container entrypoint (captures Docker env vars before exec'ing systemd)
COPY container-assets/systemd/container-entrypoint.sh /opt/discobot/bin/
RUN chmod +x /opt/discobot/bin/container-entrypoint.sh

# Copy systemd service units for container services
COPY container-assets/systemd/discobot-init.service /etc/systemd/system/
COPY container-assets/systemd/discobot-proxy.service /etc/systemd/system/
COPY container-assets/systemd/discobot-agent-api.service /etc/systemd/system/
COPY container-assets/systemd/docker.service.d/ /etc/systemd/system/docker.service.d/

# Configure systemd for container environment
RUN set -ex \
    # Mask unnecessary services that don't apply to containers
    && systemctl mask \
        getty@.service \
        serial-getty@.service \
        systemd-resolved.service \
        systemd-timesyncd.service \
        systemd-networkd.service \
        systemd-logind.service \
        systemd-udevd.service \
        dev-hugepages.mount \
        sys-fs-fuse-connections.mount \
        sys-kernel-config.mount \
        sys-kernel-debug.mount \
    # Disable CPU/memory accounting to reduce cgroup overhead in containers
    && mkdir -p /etc/systemd/system.conf.d \
    && printf '[Manager]\nDefaultCPUAccounting=no\nDefaultMemoryAccounting=no\n' \
        > /etc/systemd/system.conf.d/container.conf \
    # Enable discobot services and Docker
    && systemctl enable \
        discobot-init.service \
        discobot-proxy.service \
        discobot-agent-api.service \
        docker.service

# systemd does not respond to SIGTERM; it needs SIGRTMIN+3 for graceful shutdown
STOPSIGNAL SIGRTMIN+3

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

# Use systemd as PID 1 via entrypoint that captures Docker env vars first.
# systemd handles process supervision, zombie reaping, and signal forwarding.
# Services: discobot-init (oneshot setup) -> discobot-proxy, docker, discobot-agent-api
CMD ["/opt/discobot/bin/container-entrypoint.sh"]

# Stage 5: VZ root filesystem builder with systemd and Docker
# Build with: docker build --target vz-image --output type=local,dest=. .
# This creates a minimal systemd-based system with Docker daemon for macOS Virtualization.framework
# This stage is completely independent from the runtime image
FROM ubuntu:24.04 AS vz-rootfs-builder

# Prevent interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# Install kernel, systemd, Docker, and minimal tools
# Use a specific stable kernel version with virtio drivers built-in
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && sed -i 's|http://|https://|g' /etc/apt/sources.list.d/ubuntu.sources \
    && apt-get update && apt-get install -y --no-install-recommends \
    # Kernel with virtio support built-in (no modules needed)
    # Using specific version to avoid metapackage dependency issues
    linux-image-6.8.0-31-generic \
    linux-modules-6.8.0-31-generic \
    # systemd as init system with network support
    systemd \
    systemd-sysv \
    systemd-resolved \
    systemd-timesyncd \
    # Docker daemon and dependencies
    docker.io \
    iptables \
    # Minimal essential tools
    socat \
    # e2fsprogs for mkfs.ext4 to format data disk
    e2fsprogs \
    # udev for device enumeration
    udev \
    && rm -rf /var/lib/apt/lists/*

# Create /var skeleton for first-boot initialization
# This is copied to /var after the data disk is mounted
RUN cp -a /var /var.skel

# Copy VM assets (systemd units, scripts, network config, fstab)
COPY vm-assets/fstab /etc/fstab
COPY vm-assets/systemd/docker-vsock-proxy.service /etc/systemd/system/
COPY vm-assets/systemd/init-var.service /etc/systemd/system/
COPY vm-assets/systemd/mount-home.service /etc/systemd/system/
COPY vm-assets/systemd/docker.service.d/ /etc/systemd/system/docker.service.d/
COPY vm-assets/systemd/containerd.service.d/ /etc/systemd/system/containerd.service.d/
COPY vm-assets/network/20-dhcp.network /etc/systemd/network/
COPY vm-assets/scripts/init-var.sh /usr/local/bin/
COPY vm-assets/scripts/mount-home.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/init-var.sh /usr/local/bin/mount-home.sh

# Configure systemd for VM environment
RUN set -ex \
    # Disable unnecessary systemd services (but keep network services)
    && systemctl mask \
        getty@.service \
        serial-getty@.service \
    # Enable network services for connectivity
    && systemctl enable \
        systemd-networkd \
        systemd-resolved \
        systemd-timesyncd \
        fstrim.timer \
    # Enable /var initialization and home mount services
    && systemctl enable init-var.service \
    && systemctl enable mount-home.service \
    # Enable Docker service and vsock proxy
    && systemctl enable docker \
    && systemctl enable docker-vsock-proxy

# Create discobot user (UID 1000)
RUN useradd -m -s /bin/bash -u 1000 discobot || \
    (userdel -r $(getent passwd 1000 | cut -d: -f1) 2>/dev/null; useradd -m -s /bin/bash -u 1000 discobot)

# Create minimal directory structure for VM
# /Users is for macOS host home directory VirtioFS mounts (root is read-only squashfs)
RUN mkdir -p /.data /.workspace /workspace /Users \
    && chown discobot:discobot /.data /workspace

# Stage 6: Extract kernel and initrd, create root filesystem image
FROM ubuntu:24.04 AS vz-image-builder

# Install tools for image creation and kernel extraction
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && sed -i 's|http://|https://|g' /etc/apt/sources.list.d/ubuntu.sources \
    && apt-get update && apt-get install -y --no-install-recommends \
    squashfs-tools \
    && rm -rf /var/lib/apt/lists/*

# Copy the rootfs from builder
COPY --from=vz-rootfs-builder / /rootfs

# Extract kernel from /rootfs/boot (no initrd needed)
RUN set -ex \
    && cd /rootfs/boot \
    # Find the kernel (vmlinuz-*)
    && KERNEL=$(ls -1 vmlinuz-* | head -1) \
    && KERNEL_VERSION=$(echo $KERNEL | sed 's/vmlinuz-//') \
    && echo "Found kernel: $KERNEL (version: $KERNEL_VERSION)" \
    # Copy kernel to root for extraction
    && cp "$KERNEL" /vmlinuz \
    # Save kernel version
    && echo "$KERNEL_VERSION" > /kernel-version

# Prepare rootfs for VM use
RUN set -ex \
    # Create essential mount points
    && mkdir -p /rootfs/proc /rootfs/sys /rootfs/dev /rootfs/run /rootfs/tmp \
    # Configure systemd-resolved: symlink resolv.conf to stub resolver
    # This routes DNS queries through resolved's stub listener at 127.0.0.53
    && rm -f /rootfs/etc/resolv.conf \
    && ln -s /run/systemd/resolve/stub-resolv.conf /rootfs/etc/resolv.conf \
    # Clean up /boot to save space (kernel/initrd already extracted)
    && rm -rf /rootfs/boot/*

# Create SquashFS image with zstd compression
# SquashFS is built into the kernel - no initrd needed!
# Boot with: root=/dev/vda rootfstype=squashfs ro
RUN set -ex \
    && ROOTFS_SIZE_MB=$(du -sm /rootfs | cut -f1) \
    && echo "Rootfs size: ${ROOTFS_SIZE_MB}MB" \
    && echo "Creating SquashFS image with zstd compression..." \
    && mksquashfs /rootfs /rootfs.squashfs \
        -comp zstd \
        -Xcompression-level 19 \
        -noappend \
        -info \
    && SQUASHFS_SIZE_MB=$(du -m /rootfs.squashfs | cut -f1) \
    && RATIO=$((100 - (SQUASHFS_SIZE_MB * 100 / ROOTFS_SIZE_MB))) \
    && echo "SquashFS image: ${SQUASHFS_SIZE_MB}MB (${RATIO}% reduction)"

# Stage 7: Output stage with kernel and SquashFS root filesystem (no initrd needed)
FROM scratch AS vz-image
COPY --from=vz-image-builder /vmlinuz /vmlinuz
COPY --from=vz-image-builder /kernel-version /kernel-version
COPY --from=vz-image-builder /rootfs.squashfs /discobot-rootfs.squashfs

# Default target: runtime image
FROM runtime
