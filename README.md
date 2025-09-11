# Lock.host
Lock.host extends TEE trust anchors into the browser, see:
+ [lock.host-node](https://github.com/rhodey/lock.host-node)
+ [lock.host-python](https://github.com/rhodey/lock.host-python)
+ [IPFS-boot](https://github.com/rhodey/IPFS-boot)

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
