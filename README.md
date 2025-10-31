# Lock.host
Lock.host is the best TEE codebase online

AWS Nitro, Docker, any language, and net, see:
+ [lock.host-node](https://github.com/rhodey/lock.host-node)
+ [lock.host-python](https://github.com/rhodey/lock.host-python)
+ [IPFS-boot](https://github.com/rhodey/IPFS-boot)
+ [lock.host-ssh](https://github.com/rhodey/lock.host-ssh)

## Summary
AWS Nitro Enclaves are the AWS TEE product

AWS has a $100 Billion dollar business selling isolated compute to customers

Every Nitro TEE lives with AWS so there is only 1 party to trust and since 2020 release Nitro has 0 exploits

Nitro TEE (like other TEEs) supports attestation

Users HTTP2 connect to Nitro and the Lock.host stack sends an attest doc with key for an ephemeral session

Developers code normal TCP or HTTP servers and inherit from a base docker image and everything just works

## Setup
Install docker using common docs then install just:
```
apt install -y just
```

## Build images
Build base images like this then continue to [lock.host-node](https://github.com/rhodey/lock.host-node) or [lock.host-python](https://github.com/rhodey/lock.host-python):
```
just serve-alpine
just build-runtime build-host
```

## Update apline
Modify apk/Dockerfile.fetch to include all apks then run:
```
just proxy-alpine
just fetch-alpine
```

## Why alpine
Updates to alpine apks are published all the time

Lock.host needs full reproducibility and so alpine apks are checked into git

Apk signatures are unchanged

## Rust dev
To build rust on host (no docker) run:
```
just rust
```

## Root.pem
See that [run.yml](.github/workflows/run.yml) is testing that this file is genuine

## License
MIT
