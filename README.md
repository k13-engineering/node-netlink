# node-netlink

[![CI](https://github.com/k13-engineering/node-netlink/actions/workflows/ci.yml/badge.svg)](https://github.com/k13-engineering/node-netlink/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/node-netlink)](https://www.npmjs.com/package/node-netlink)

Typed [netlink](https://man7.org/linux/man-pages/man7/netlink.7.html) sockets for Node.js on Linux, written in TypeScript.

- **Synchronous where possible.** Opening, binding, sending and closing a socket are plain function calls. Only waiting for responses of the kernel returns a promise.
- **Request/response matching.** `talk()` sends a request, collects all responses including multipart dumps and resolves once the kernel acknowledges it or reports an error.
- **No native code of its own.** The syscalls are performed by [po6](https://www.npmjs.com/package/po6), readiness is signaled by the libuv event loop via [@k13engineering/uv-poll](https://www.npmjs.com/package/@k13engineering/uv-poll).
- **Checked against the C headers.** The layouts of `struct sockaddr_nl`, `struct nlmsghdr` and `struct nlmsgerr` are defined with [ya-struct](https://www.npmjs.com/package/ya-struct) and compared with `<linux/netlink.h>` in the tests, as are all constants.
- **Testable.** The socket is injected through a small transport interface, so the protocol handling runs against fakes in unit tests.

node-netlink handles the netlink framing. The payloads of the individual protocols, e.g. `struct ifinfomsg` and attributes of rtnetlink, are `Uint8Array`s that you format and parse yourself.

## Requirements

- Linux on x86_64 or arm64
- Node.js 24 or newer

## Installation

```sh
npm install node-netlink
```

## Usage

### Requests

```ts
import { NETLINK_ROUTE, NLM_F_DUMP, openNetlinkSocket } from "node-netlink";

// <linux/rtnetlink.h>
const RTM_GETLINK = 18n;

const socket = openNetlinkSocket({ family: NETLINK_ROUTE });

try {
  // dump all network interfaces, the payload is a zeroed struct ifinfomsg
  const links = await socket.talk({
    header: { nlmsg_type: RTM_GETLINK, nlmsg_flags: NLM_F_DUMP },
    payload: new Uint8Array(16),
  });

  links.forEach(({ header, payload }) => {
    const index = new DataView(payload.buffer, payload.byteOffset).getInt32(4, true);
    console.log(`type ${header.nlmsg_type}, interface index ${index}`);
  });
} finally {
  socket.close();
}
```

`talk()` rejects if the kernel reports an error, e.g. `netlink request of type 16 failed with EPERM: Operation not permitted`. The error has the `errno` attached. Use `tryTalk()` to get the errno as a value instead:

```ts
const { errno, messages } = await socket.tryTalk({
  header: { nlmsg_type: RTM_GETLINK },
  payload: ifinfomsgOfInterface,
});

if (errno !== undefined) {
  // e.g. 19 (ENODEV) if the interface does not exist
}
```

### Notifications

Messages that are not responses to a pending request, e.g. multicast notifications, are passed to `onMessage`:

```ts
import { NETLINK_ROUTE, openNetlinkSocket } from "node-netlink";

const RTMGRP_LINK = 1n;

const socket = openNetlinkSocket({
  family: NETLINK_ROUTE,
  nl_groups: RTMGRP_LINK,
  onMessage: ({ message }) => {
    console.log("link changed", message.header.nlmsg_type);
  },
  onError: ({ error }) => {
    console.error(error);
  },
});
```

An open socket keeps the Node.js process alive until `close()` is called.

See [examples/](examples/) for complete programs that list interfaces and monitor link changes.

## API

All functions take a single object of arguments. Header fields are `bigint`s, like the values ya-struct parses.

### `openNetlinkSocket({ family, nl_pid?, nl_groups?, onMessage?, onError? })`

Creates a netlink socket of the protocol `family` (e.g. `NETLINK_ROUTE`) and binds it synchronously. Throws if the socket cannot be created or bound.

- `nl_pid`: the port id to bind to, `0n` (default) lets the kernel assign one
- `nl_groups`: bitmask of multicast groups to join, `0n` by default
- `onMessage({ message })`: called for every received message that is not a response to a pending request
- `onError({ error })`: called for errors while receiving, e.g. `ENOBUFS` when the receive buffer overflowed and messages were lost. Without a handler, such errors are thrown asynchronously as uncaught exceptions.

Returns a socket with:

| Member | Description |
| --- | --- |
| `nl_pid`, `nl_groups` | the address the socket is bound to, queried synchronously with `getsockname()` |
| `talk({ header, payload, timeoutMs? })` | sends a request and resolves with all responses, rejects if the kernel reports an error |
| `tryTalk({ header, payload, timeoutMs? })` | like `talk()`, but resolves with `{ errno, messages }`. `errno` is `undefined` on success |
| `send({ header, payload })` | sends a message without waiting for a response and returns `{ nlmsg_seq }`. `nlmsg_flags` defaults to `NLM_F_REQUEST`, `nlmsg_seq` to the next sequence number |
| `close()` | closes the socket and rejects pending requests. Calling it again has no effect |

For `talk()` and `tryTalk()`, `header` is `{ nlmsg_type, nlmsg_flags? }`. `NLM_F_REQUEST` and `NLM_F_ACK` are always set, and the sequence number is assigned automatically. A request completes with the acknowledgement (`NLMSG_ERROR`) or, for dumps, with `NLMSG_DONE`. `timeoutMs` defaults to 10 seconds.

A message is `{ header: { nlmsg_type, nlmsg_flags, nlmsg_seq, nlmsg_pid }, payload: Uint8Array }`. The responses of `talk()` and `tryTalk()` don't include the terminating `NLMSG_ERROR` or `NLMSG_DONE`.

### Messages

| Function | Description |
| --- | --- |
| `parseMessages({ data, structures })` | splits a datagram into its messages, throws if it is malformed |
| `formatMessage({ message, structures })` | formats a message, `nlmsg_len` is calculated |
| `errnoOfMessage({ message, structures })` | the errno of an `NLMSG_ERROR` or `NLMSG_DONE`, `undefined` for acknowledgements and other messages |
| `nlmsgAlign({ length })` | rounds up to the netlink alignment of 4 bytes |

Pass `hostStructures` as `structures`, or `createNetlinkStructuresFor({ abi })` for another byte order. The ya-struct definitions are exported as `sockaddrNlDefinition`, `nlmsghdrDefinition` and `nlmsgerrDefinition`.

### Constants

`AF_NETLINK`, the protocol families `NETLINK_*`, the header flags `NLM_F_*` and the message types `NLMSG_*` of `<linux/netlink.h>` are exported as `bigint`s.

### Dependency injection

`openNetlinkSocket()` is `createNetlink().open()` wired to the real system. Each layer gets its dependencies passed in, so it can be used with other implementations, e.g. in tests:

```ts
import { createPoller } from "@k13engineering/uv-poll";
import { pinBuffer } from "buffer2address";
import { createKernelAbiFor, createLinuxKernelInterface, createPo6Api, hostAbi } from "po6";
import { syscall, syscallNumbers } from "syscall-napi";
import { createNetlink, createPo6TransportFactory, hostStructures } from "node-netlink";

const kernelAbi = createKernelAbiFor({ machineAbi: hostAbi });
const po6 = createPo6Api({
  kernelInterface: createLinuxKernelInterface({ syscall, syscallNumbers }),
  kernelAbi,
  memory: { pinBuffer },
});

// the operating system side: po6 syscalls and a poller, replaceable by fakes
const transportFactory = createPo6TransportFactory({ po6, kernelAbi, createPoller, structures: hostStructures });

// the protocol side: works with any TNetlinkTransportFactory
const { open } = createNetlink({
  transportFactory,
  structures: hostStructures,
  createErrorFromErrno: po6.createErrorFromErrno,
  reportUnhandledError: ({ error }) => {
    console.error(error);
  },
});
```

A `TNetlinkTransportFactory` receives `{ family, address, onData, onError }` and returns `{ address, send({ data }), close() }`.

## Migrating from 0.0.x

- The package is an ES module with named exports. `import netlink from "node-netlink"` becomes `import { openNetlinkSocket } from "node-netlink"`.
- `netlink.open()` returned a promise, `openNetlinkSocket()` returns the socket directly. `family`, `pid` and `groups` are now `family`, `nl_pid` and `nl_groups` and must be `bigint`s.
- `talk(message, { timeout })` is now `talk({ header, payload, timeoutMs })`. `NLM_F_REQUEST` and `NLM_F_ACK` are set automatically instead of being required.
- `tryTalk()` resolves with `{ errno, messages }` instead of `{ errorCode, packets }`. `errno` is `undefined` instead of `0` on success.
- `on("message", listener)` is replaced by the `onMessage` and `onError` options. Responses to pending requests are no longer passed to it.
- `close()` is synchronous.
- `createErrorFromErrorCode()` is gone. Errors of `talk()` carry the `errno` and the message of po6.
- po6-socket was replaced by po6, which needs no native code of its own.

## Development

```sh
npm ci
npm run build       # transpile to dist/
npm run type-check
npm run test        # mocha with c8, 100% coverage required
npm run lint
```

The sources are in `lib/`, tests are next to them as `*.spec.ts`:

- `lib/netlink-socket.ts`: requests, responses and sequence numbers on top of an injected transport
- `lib/po6-transport.ts`: the transport on top of po6 syscalls and a poller, both injected
- `lib/system.ts`: wires everything to syscall-napi, buffer2address and uv-poll
- `lib/message.ts`, `lib/structures.ts`, `lib/constants.ts`: framing, structure layouts and constants

The unit tests use the fakes in `lib/test-support/`. `lib/index.spec.ts` talks to the kernel of the host via `NETLINK_ROUTE` and needs no privileges. The structure layouts and constants are compared with the C headers by compiling C programs, so `gcc` and the Linux headers are required.

Releases are published by pushing a tag like `v0.1.0`, which builds the package, merges `package.npm.json` into `package.json` and sets the version.

## License

LGPL-2.1, see [LICENSE](LICENSE).
