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
FROM ubuntu:24.04 AS runtime

# Install only essential runtime dependencies
# socat is needed for vsock forwarding in VZ VMs
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    socat \
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

EXPOSE 3002

CMD ["./octobot-agent"]

# Stage 4: VZ disk image builder (non-default target)
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
    && mkdir -p /rootfs/run/octobot/metadata \
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
# Mount VirtioFS metadata (shared from host)\n\
mkdir -p /run/octobot/metadata\n\
mount -t virtiofs octobot-meta /run/octobot/metadata 2>/dev/null || true\n\
\n\
# Start the agent\n\
cd /app\n\
exec ./octobot-agent\n\
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
COPY --from=vz-disk-image-builder /disk.img.zst /octobot-rootfs.img.zst

# Stage 5: Linux kernel builder for VZ
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
