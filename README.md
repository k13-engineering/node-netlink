# node-netlink

[![CI](https://github.com/k13-engineering/node-netlink/actions/workflows/ci.yml/badge.svg)](https://github.com/k13-engineering/node-netlink/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/node-netlink)](https://www.npmjs.com/package/node-netlink)

The [netlink](https://man7.org/linux/man-pages/man7/netlink.7.html) protocol for Node.js on Linux, written in TypeScript.

- **Bring your own socket.** node-netlink never opens, binds or closes a socket. You pass in a netlink socket you own, and the library speaks the protocol on top of it.
- **Request/response matching.** `talk()` sends a request, collects all responses including multipart dumps and resolves once the kernel acknowledges it or reports an error.
- **Synchronous where possible.** Attaching to a socket, querying its address and sending are plain function calls. Only waiting for responses of the kernel returns a promise.
- **No native code.** The adapter for file descriptors uses the [po6](https://www.npmjs.com/package/po6) API and the poller you pass in, e.g. [@k13engineering/uv-poll](https://www.npmjs.com/package/@k13engineering/uv-poll).
- **Checked against the C headers.** The layouts of `struct sockaddr_nl`, `struct nlmsghdr` and `struct nlmsgerr` are defined with [ya-struct](https://www.npmjs.com/package/ya-struct) and compared with `<linux/netlink.h>` in the tests, as are all constants.

node-netlink handles the netlink framing. The payloads of the individual protocols, e.g. `struct ifinfomsg` and attributes of rtnetlink, are `Uint8Array`s that you format and parse yourself.

## Requirements

- Linux
- Node.js 24 or newer

## Installation

```sh
npm install node-netlink
```

To use the included adapter for file descriptors, install po6 with its syscall and memory backends and a poller:

```sh
npm install po6 syscall-napi buffer2address @k13engineering/uv-poll
```

## Usage

### Setup

Open and bind the socket with po6, then attach node-netlink to it:

```ts
import { createPoller } from "@k13engineering/uv-poll";
import { pinBuffer } from "buffer2address";
import { createKernelAbiFor, createLinuxKernelInterface, createPo6Api, hostAbi } from "po6";
import { syscall, syscallNumbers } from "syscall-napi";
import {
  AF_NETLINK,
  NETLINK_ROUTE,
  createNetlinkSocket,
  createPo6NetlinkTransport,
  formatNetlinkAddress,
} from "node-netlink";

const kernelAbi = createKernelAbiFor({ machineAbi: hostAbi });
const po6 = createPo6Api({
  kernelInterface: createLinuxKernelInterface({ syscall, syscallNumbers }),
  kernelAbi,
  memory: { pinBuffer },
});

// <linux/net.h> and <asm-generic/fcntl.h>
const SOCK_RAW = 3n;
const SOCK_CLOEXEC = 0o2000000n;

// your socket: opened, bound and closed by your code
const { errno, fd } = po6.socket({ domain: AF_NETLINK, type: SOCK_RAW | SOCK_CLOEXEC, protocol: NETLINK_ROUTE });
if (errno !== undefined) {
  throw po6.createErrorFromErrno({ operation: "socket()", errno });
}

const { errno: bindErrno } = po6.bind({ fd, sockaddr: formatNetlinkAddress({ address: { nl_pid: 0n, nl_groups: 0n } }) });
if (bindErrno !== undefined) {
  throw po6.createErrorFromErrno({ operation: "bind()", errno: bindErrno });
}

// the netlink protocol on top of it
const transport = createPo6NetlinkTransport({ fd, po6, kernelAbi, createPoller });
const netlink = createNetlinkSocket({ transport });
```

When you are done, detach node-netlink and close the socket yourself:

```ts
netlink.detach();
po6.close({ fd });
```

### Requests

```ts
import { NLM_F_DUMP } from "node-netlink";

// <linux/rtnetlink.h>
const RTM_GETLINK = 18n;

// dump all network interfaces, the payload is a zeroed struct ifinfomsg
const links = await netlink.talk({
  header: { nlmsg_type: RTM_GETLINK, nlmsg_flags: NLM_F_DUMP },
  payload: new Uint8Array(16),
});

links.forEach(({ header, payload }) => {
  const index = new DataView(payload.buffer, payload.byteOffset).getInt32(4, true);
  console.log(`type ${header.nlmsg_type}, interface index ${index}`);
});
```

`talk()` rejects if the kernel reports an error, e.g. `netlink request of type 16 failed with EPERM`. The error has the `errno` attached. Use `tryTalk()` to get the errno as a value instead:

```ts
const { errno, messages } = await netlink.tryTalk({
  header: { nlmsg_type: RTM_GETLINK },
  payload: ifinfomsgOfInterface,
});

if (errno !== undefined) {
  // e.g. 19 (ENODEV) if the interface does not exist
}
```

### Notifications

Bind the socket to multicast groups, e.g. `nl_groups: 1n` for `RTMGRP_LINK`. Messages that are not responses to a pending request are passed to `onMessage`:

```ts
const netlink = createNetlinkSocket({
  transport,
  onMessage: ({ message }) => {
    console.log("link changed", message.header.nlmsg_type);
  },
  onError: ({ error }) => {
    console.error(error);
  },
});
```

While attached, the poller keeps the Node.js process alive.

See [examples/](examples/) for complete programs that list interfaces and monitor link changes.

## API

All functions take a single object of arguments. Header fields are `bigint`s, like the values ya-struct parses.

### `createNetlinkSocket({ transport, onMessage?, onError?, structures? })`

Attaches the netlink protocol to `transport` and starts listening on it.

- `transport`: the socket to use, see [Transports](#transports)
- `onMessage({ message })`: called for every received message that is not a response to a pending request
- `onError({ error })`: called for errors while receiving, e.g. `ENOBUFS` when the receive buffer overflowed and messages were lost. Without a handler, such errors are thrown asynchronously as uncaught exceptions.
- `structures`: layouts of the kernel structures, `hostStructures` by default

Returns:

| Member | Description |
| --- | --- |
| `nl_pid`, `nl_groups` | the address the socket is bound to, as reported by the transport |
| `talk({ header, payload, timeoutMs? })` | sends a request and resolves with all responses, rejects if the kernel reports an error |
| `tryTalk({ header, payload, timeoutMs? })` | like `talk()`, but resolves with `{ errno, messages }`. `errno` is `undefined` on success |
| `send({ header, payload })` | sends a message without waiting for a response and returns `{ nlmsg_seq }`. `nlmsg_flags` defaults to `NLM_F_REQUEST`, `nlmsg_seq` to the next sequence number |
| `detach()` | stops listening and rejects pending requests. The socket stays open, closing it is up to you. Calling it again has no effect |

For `talk()` and `tryTalk()`, `header` is `{ nlmsg_type, nlmsg_flags? }`. `NLM_F_REQUEST` and `NLM_F_ACK` are always set, and the sequence number is assigned automatically. A request completes with the acknowledgement (`NLMSG_ERROR`) or, for dumps, with `NLMSG_DONE`. `timeoutMs` defaults to 10 seconds.

A message is `{ header: { nlmsg_type, nlmsg_flags, nlmsg_seq, nlmsg_pid }, payload: Uint8Array }`. The responses of `talk()` and `tryTalk()` don't include the terminating `NLMSG_ERROR` or `NLMSG_DONE`.

### Transports

A transport is the socket node-netlink talks through:

```ts
type TNetlinkTransport = {
  // the address the socket is bound to
  address: { nl_pid: bigint, nl_groups: bigint };
  // sends a datagram to the kernel, throws on failure
  send: (args: { data: Uint8Array }) => void;
  // passes received datagrams to onData until stop() is called
  listen: (args: {
    onData: (args: { data: Uint8Array }) => void;
    onError: (args: { error: Error }) => void;
  }) => { stop: () => void };
};
```

Implement it yourself, e.g. as a fake in tests, or adapt a file descriptor with `createPo6NetlinkTransport({ fd, po6, kernelAbi, createPoller, structures? })`:

- `fd`: a netlink socket, opened and bound by you. Blocking and non-blocking sockets both work, as it receives with `MSG_DONTWAIT`.
- `po6`: an object with `getsockname()`, `sendmsg()`, `recvmsg()` and `createErrorFromErrno()` of the po6 API
- `kernelAbi`: the po6 kernel ABI, for the `MSG_*` constants and errno values
- `createPoller({ fd })`: returns a poller with `armOnce({ readable, error })` and `close()`, like `createPoller` of @k13engineering/uv-poll

The adapter queries the address with `getsockname()` when it is created and throws if `fd` is not a netlink socket. `listen()` creates a poller, `stop()` closes it. The file descriptor is never closed.

### Messages

| Function | Description |
| --- | --- |
| `parseMessages({ data, structures })` | splits a datagram into its messages, throws if it is malformed |
| `formatMessage({ message, structures })` | formats a message, `nlmsg_len` is calculated |
| `errnoOfMessage({ message, structures })` | the errno of an `NLMSG_ERROR` or `NLMSG_DONE`, `undefined` for acknowledgements and other messages |
| `nlmsgAlign({ length })` | rounds up to the netlink alignment of 4 bytes |
| `formatNetlinkAddress({ address, structures? })` | formats a `struct sockaddr_nl`, e.g. for `bind()` |
| `createErrorFromErrno({ operation, errno })` | creates the errors `talk()` rejects with |

Pass `hostStructures` as `structures`, or `createNetlinkStructuresFor({ abi })` for another byte order. The ya-struct definitions are exported as `sockaddrNlDefinition`, `nlmsghdrDefinition` and `nlmsgerrDefinition`.

### Constants

`AF_NETLINK`, the protocol families `NETLINK_*`, the header flags `NLM_F_*` and the message types `NLMSG_*` of `<linux/netlink.h>` are exported as `bigint`s.

## Migrating from 0.0.x

- node-netlink no longer creates sockets. Replace `netlink.open({ family, pid, groups })` with your own `socket()` and `bind()`, see [Setup](#setup), and `createNetlinkSocket({ transport })`. The new function is synchronous.
- `close()` is replaced by `detach()`, which leaves the socket open. Close it yourself afterwards.
- The package is an ES module with named exports, there is no default export anymore.
- `talk(message, { timeout })` is now `talk({ header, payload, timeoutMs })`. `NLM_F_REQUEST` and `NLM_F_ACK` are set automatically instead of being required.
- `tryTalk()` resolves with `{ errno, messages }` instead of `{ errorCode, packets }`. `errno` is `undefined` instead of `0` on success.
- `on("message", listener)` is replaced by the `onMessage` and `onError` options. Responses to pending requests are no longer passed to it.
- `createErrorFromErrorCode({ errorCode })` is now `createErrorFromErrno({ operation, errno })`.
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
- `lib/po6-transport.ts`: the transport for a file descriptor, using injected po6 syscalls and an injected poller
- `lib/message.ts`, `lib/structures.ts`, `lib/constants.ts`, `lib/errno.ts`: framing, structure layouts, constants and errors

The unit tests use the fakes in `lib/test-support/`. `lib/index.spec.ts` opens real sockets with `lib/test-support/host-socket.ts` and talks to the kernel of the host via `NETLINK_ROUTE`, which needs no privileges. The structure layouts and constants are compared with the C headers by compiling C programs, so `gcc` and the Linux headers are required.

Releases are published by pushing a tag like `v0.1.0`, which builds the package, merges `package.npm.json` into `package.json` and sets the version.

## License

LGPL-2.1, see [LICENSE](LICENSE).
