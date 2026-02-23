# Lock.host (soon)
Write AI Agents & Smart Contracts in Rust and JS and use SQLite at $6/mo per GB stored. And all is encrypted.

Lock.host is the only place where you will get also outbound HTTPS requests.
+ ~~[lock.host-wasm-rust](https://github.com/rhodey/lock.host-wasm-rust)~~ (soon)
+ [lock.host-wasm-js](https://github.com/rhodey/lock.host-wasm-js)
+ [lock.host-keys](https://github.com/rhodey/lock.host-keys)
+ [IPFS-boot](https://github.com/rhodey/IPFS-boot)

## About
Lock.host is focused on [Trusted Execution Environments](https://en.wikipedia.org/wiki/Trusted_execution_environment) (TEEs). Developers install `programA` into a TEE and the TEE will send an attest doc that says `programA` is online. The attest doc includes a public key for comms with `programA` and most important: **the attest doc is signed by somebody**.

AWS has a $100 Billion dollar business selling isolated compute to customers. [AWS Nitro Enclaves](https://aws.amazon.com/ec2/nitro/nitro-enclaves/) are the AWS TEE product and Lock.host uses Nitro. Every Nitro TEE is made by AWS and lives with AWS so there is `1` party to trust. When developers work with TEEs correctly, using Lock.host or otherwise, the app developer at most can take the app offline.

## Alternatives
+ Lock.host does not do zero knowledge proofs
+ Lock.host does not do fully homomorphic encryption
+ Lock.host does not do "multi party computation"

All of the above have merit. All of the above require extra compute (lots). And all of the above involve fundamentally new math (scary). Things will change with time but it will always be true that TEEs run code the fastest. If you are developing in an area that cannot be slow TEEs will always be your friend. If you are developing in an area that needs the best privacy (today) you may agree AWS Nitro is this also. If you want to [develop using SQLite](https://github.com/rhodey/sqlitesuperfs) this is ready today.

## Setup
If you want to code [WASM](https://en.wikipedia.org/wiki/WebAssembly) apps using Rust or JS: use the links above. If you want to self-host Nitro apps with the Lock.host stack: start by installing docker using common docs then install [just](https://github.com/casey/just):
```
apt install just
(or brew install just)
```

## Build images
Build base images like this then continue to [lock.host-node](https://github.com/rhodey/lock.host-node) or [lock.host-python](https://github.com/rhodey/lock.host-python)

Lock.host allows all languages but you will want to look at one of the examples
```
just serve-alpine
just build-runtime build-host
```

## Apline dev
Modify apk/Dockerfile.fetch to include new apks then run:
```
just proxy-alpine
just fetch-alpine
```

## Rust dev
To build rust on host (no docker) run:
```
just rust
```

## Root.pem
See that [run.yml](.github/workflows/run.yml) is testing that this file is genuine

## License
hello@lock.host

MIT
