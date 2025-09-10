sudo := "$(docker info > /dev/null 2>&1 || echo 'sudo')"

#######################
## Build base images ##
#######################

serve-alpine:
    python3 -m http.server -d apk/ 8081

build-rust:
    {{sudo}} docker buildx build --platform="linux/amd64" -f Dockerfile.rust -t lockhost-rust .
    {{sudo}} docker rm -f lockhost-rust > /dev/null  2>&1 || true
    {{sudo}} docker run --platform="linux/amd64" --name lockhost-rust lockhost-rust
    mkdir -p dist
    {{sudo}} docker cp lockhost-rust:/workspace/rust/target/x86_64-unknown-linux-musl/release/vsock ./dist/
    {{sudo}} docker cp lockhost-rust:/workspace/rust/target/x86_64-unknown-linux-musl/release/attest ./dist/
    {{sudo}} docker cp lockhost-rust:/workspace/rust/target/x86_64-unknown-linux-musl/release/attest-parse ./dist/
    {{sudo}} docker rm -f lockhost-rust > /dev/null  2>&1 || true

build-runtime:
    just build-rust
    {{sudo}} docker buildx build --platform="linux/amd64" -f Dockerfile.runtime -t lockhost-runtime .

build-host:
    just build-rust
    {{sudo}} docker buildx build --platform="linux/amd64" -f Dockerfile.host -t lockhost-host .


#########################
## Allow update alpine ##
#########################

build-proxy-alpine:
    {{sudo}} docker buildx build -f apk/Dockerfile.proxy -t lockhost-proxy-alpine .

proxy-alpine:
    just build-proxy-alpine
    {{sudo}} docker run --rm -it -v ./apk:/root/apk -p 8080:8080 lockhost-proxy-alpine

fetch-alpine:
    {{sudo}} docker buildx build --platform="linux/amd64" -f apk/Dockerfile.fetch -t lockhost-fetch-alpine .


####################
## Rust no docker ##
####################

build-vsock:
    cargo build --manifest-path=rust/Cargo.toml --release --bin vsock

build-attest:
    cargo build --manifest-path=rust/Cargo.toml --release --bin attest

build-attest-parse:
    cargo build --manifest-path=rust/Cargo.toml --features ssl --release --bin attest-parse

rust:
    just build-vsock
    just build-attest
    just build-attest-parse
