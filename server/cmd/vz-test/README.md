# VZ Docker Test CLI

A simple command-line tool for testing Apple Virtualization framework VMs with Docker support on macOS.

## What It Does

1. **Creates a Linux VM** using Apple's Virtualization.framework
2. **Waits for Docker daemon** to start inside the VM
3. **Exposes Docker socket** via a Unix socket proxy
4. **Allows Docker CLI usage** against the VM's Docker daemon

This is useful for testing VM images and Docker connectivity before integrating into the full system.

## Prerequisites

- macOS 12.0+ (Big Sur or later)
- Apple Silicon or Intel Mac
- A Linux kernel (vmlinuz)
- A base disk image with Docker daemon installed

## Building

```bash
cd server
go build -o vz-test ./cmd/vz-test
```

## Usage

### Basic Usage

```bash
./vz-test \
  -kernel /path/to/vmlinuz \
  -base-disk /path/to/base-docker.img
```

### Full Options

```bash
./vz-test \
  -kernel /path/to/vmlinuz \
  -initrd /path/to/initrd \
  -base-disk /path/to/base-docker.img \
  -data-dir /tmp/vz-test \
  -console-log-dir /tmp/vz-test/logs \
  -socket /tmp/vz-docker.sock \
  -project my-project \
  -cpus 2 \
  -memory 2048
```

### Command Line Flags

| Flag | Default | Description |
|------|---------|-------------|
| `-kernel` | *required* | Path to Linux kernel (vmlinuz) |
| `-base-disk` | *required* | Path to base disk image with Docker |
| `-initrd` | - | Path to initial ramdisk (optional) |
| `-data-dir` | `/tmp/vz-test` | Directory for VM disk images |
| `-console-log-dir` | `/tmp/vz-test/logs` | Directory for console logs |
| `-socket` | `/tmp/vz-docker.sock` | Unix socket path for Docker CLI |
| `-project` | `test-project` | Project ID for the VM |
| `-cpus` | `2` | Number of CPUs for the VM |
| `-memory` | `2048` | Memory in MB for the VM |

## Using Docker CLI

Once the VM is running, the tool will display:

```
✓ VM is ready!

You can now use Docker CLI:
  export DOCKER_HOST=unix:///tmp/vz-docker.sock
  docker ps
  docker run hello-world

Console log: /tmp/vz-test/logs/project-test-project/console.log

Press Ctrl+C to shutdown...
```

### In Another Terminal

```bash
# Set Docker host to the VM's socket
export DOCKER_HOST=unix:///tmp/vz-docker.sock

# Run Docker commands
docker info
docker ps
docker run -it alpine sh
docker run hello-world
```

## Viewing Console Output

The VM console output is logged to:
```
{console-log-dir}/project-{project-id}/console.log
```

Default: `/tmp/vz-test/logs/project-test-project/console.log`

To watch it in real-time:
```bash
tail -f /tmp/vz-test/logs/project-test-project/console.log
```

## VM Disk Layout

The tool creates two disk images:

```
{data-dir}/
├── project-{project-id}.img       # Root disk (read-only, cloned from base)
└── project-{project-id}-data.img  # Data disk (read-write, 20GB)
```

- **Root disk**: Cloned from your base image, mounted read-only
- **Data disk**: Created once, persistent storage for Docker

## Creating a Base Disk Image

Your base disk image must be in **SquashFS format** and include:

1. **Linux with virtio drivers** (virtio_blk, virtio_net, virtio_console, vsock)
2. **SquashFS support** in the kernel (`CONFIG_SQUASHFS=y`)
3. **Docker daemon**
4. **socat** for VSOCK bridging

The root filesystem will be mounted read-only from the SquashFS image.

### Example Init Script (inside VM)

```bash
#!/bin/sh
set -e

# Mount data disk for Docker
if ! blkid /dev/vdb; then
  mkfs.ext4 -L docker-data /dev/vdb
fi
mkdir -p /var/lib/docker
mount /dev/vdb /var/lib/docker

# Start Docker
dockerd --data-root=/var/lib/docker &

# Wait for Docker
until docker info >/dev/null 2>&1; do
  sleep 1
done

# Bridge Docker socket to VSOCK
socat VSOCK-LISTEN:2375,reuseaddr,fork UNIX-CONNECT:/var/run/docker.sock &

echo "Ready"
wait
```

See [VZ README](../../internal/sandbox/vz/README.md) for complete image requirements.

## Example Session

```bash
# Terminal 1: Start VM
$ ./vz-test -kernel vmlinuz -base-disk base-docker.img
VZ Docker Test CLI
==================
Kernel:       vmlinuz
Base Disk:    base-docker.img
Data Dir:     /tmp/vz-test
Console Logs: /tmp/vz-test/logs
Docker Socket: /tmp/vz-docker.sock

Creating VM manager...
Creating VM for project: test-project
[VM test-project] Booting...
[VM test-project] Docker starting...
Docker daemon ready in VM: test-project

✓ VM is ready!

You can now use Docker CLI:
  export DOCKER_HOST=unix:///tmp/vz-docker.sock
  docker ps
  docker run hello-world

Press Ctrl+C to shutdown...
```

```bash
# Terminal 2: Use Docker
$ export DOCKER_HOST=unix:///tmp/vz-docker.sock
$ docker info
Server:
 Containers: 0
  Running: 0
  Paused: 0
  Stopped: 0
 Images: 0
 ...

$ docker run hello-world
Unable to find image 'hello-world:latest' locally
latest: Pulling from library/hello-world
...
Hello from Docker!
...
```

## Troubleshooting

### VM doesn't start

Check console log:
```bash
tail -f /tmp/vz-test/logs/project-test-project/console.log
```

### Docker daemon not ready

The tool waits up to 60 seconds for Docker to respond. If it times out:
- Check that your base image has Docker installed
- Verify the init script starts Docker and socat
- Check console logs for errors

### Permission denied on socket

The socket is created with `0666` permissions. If you still get errors:
```bash
ls -l /tmp/vz-docker.sock
sudo chmod 666 /tmp/vz-docker.sock
```

## Cleanup

Press `Ctrl+C` to shut down the VM. The tool will:
1. Stop the proxy
2. Shut down the VM
3. Remove the Unix socket

Disk images are preserved in the data directory and can be reused.

## Code Signing

If you get an error about entitlements, sign the binary:

```bash
codesign --entitlements vz.entitlements -s - ./vz-test
```

Where `vz.entitlements` contains:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.virtualization</key>
  <true/>
</dict>
</plist>
```
