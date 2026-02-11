.PHONY: build sign clean

# Build the binary
build:
	go build -o vz-test .

# Sign the binary with entitlements
sign: build
	codesign --entitlements vz.entitlements --force --sign - vz-test

# Clean up
clean:
	rm -f vz-test

# Default target
all: sign
