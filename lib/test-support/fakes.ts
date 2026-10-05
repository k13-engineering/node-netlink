import {
  createKernelAbiFor,
  createPo6Api,
  hostAbi,
  type TLinuxKernelInterface,
  type TMemoryInterface
} from "po6";
import type { TCreatePoller, TPo6NetlinkSyscalls, TPoller } from "../po6-transport.ts";
import type { TNetlinkTransport, TNetlinkTransportFactory } from "../netlink-socket.ts";

const kernelAbi = createKernelAbiFor({ machineAbi: hostAbi });
const { errnoCodes } = kernelAbi;

// only used for its error formatting, which needs neither syscalls nor memory
const { createErrorFromErrno } = createPo6Api({
  kernelInterface: {} as TLinuxKernelInterface,
  kernelAbi,
  memory: {} as TMemoryInterface,
});

type TSyscallName = "socket" | "bind" | "getsockname" | "sendmsg" | "recvmsg" | "close";

type TCall = {
  name: TSyscallName;
  args: Record<string, unknown>;
};

/**
 * A fake kernel for a single netlink socket.
 * Datagrams in `incoming` are returned by recvmsg(), `failures` makes the next call of a syscall fail.
 */
const createFakePo6 = () => {
  const fd = 42;

  let calls: TCall[] = [];
  let incoming: (Uint8Array | { errno: number })[] = [];
  let failures: Partial<Record<TSyscallName, (number | undefined)[]>> = {};
  let boundAddress = new Uint8Array(12);
  let assignedPid = 4711;

  const record = ({ name, args }: TCall) => {
    calls = [...calls, { name, args }];

    const [errno, ...remaining] = failures[name] ?? [];
    failures = { ...failures, [name]: remaining };
    return errno;
  };

  const socket: TPo6NetlinkSyscalls["socket"] = (args) => {
    const errno = record({ name: "socket", args });
    return errno === undefined ? { errno, fd } : { errno, fd: undefined };
  };

  const bind: TPo6NetlinkSyscalls["bind"] = (args) => {
    boundAddress = args.sockaddr.slice();
    return { errno: record({ name: "bind", args }) };
  };

  const getsockname: TPo6NetlinkSyscalls["getsockname"] = (args) => {
    const errno = record({ name: "getsockname", args });

    if (errno !== undefined) {
      return { errno, sockaddr: undefined };
    }

    const sockaddr = boundAddress.slice();
    new DataView(sockaddr.buffer).setUint32(4, assignedPid, true);
    return { errno, sockaddr };
  };

  const sendmsg: TPo6NetlinkSyscalls["sendmsg"] = (args) => {
    const errno = record({ name: "sendmsg", args });
    return errno === undefined ? { errno, bytesSent: args.data.length } : { errno, bytesSent: undefined };
  };

  // eslint-disable-next-line complexity
  const recvmsg: TPo6NetlinkSyscalls["recvmsg"] = (args) => {
    const errno = record({ name: "recvmsg", args });
    const [next, ...rest] = incoming;

    if (errno !== undefined || next === undefined) {
      return { errno: errno ?? errnoCodes.EAGAIN, bytesReceived: undefined, msghdr: undefined };
    }

    if (!(next instanceof Uint8Array)) {
      incoming = rest;
      return { errno: next.errno, bytesReceived: undefined, msghdr: undefined };
    }

    const peek = (BigInt(args.flags ?? 0) & kernelAbi.constants.MSG_PEEK) !== 0n;
    if (!peek) {
      incoming = rest;
    }

    args.data.set(next.subarray(0, args.data.length));
    const msghdr = { msg_namelen: 0, msg_controllen: 0, msg_flags: 0 };
    return { errno: undefined, bytesReceived: next.length, msghdr };
  };

  const close: TPo6NetlinkSyscalls["close"] = (args) => {
    return { errno: record({ name: "close", args }) };
  };

  const po6: TPo6NetlinkSyscalls = {
    socket,
    bind,
    getsockname,
    sendmsg,
    recvmsg,
    close,
    createErrorFromErrno,
  };

  return {
    po6,
    kernelAbi,
    fd,

    callsOf: ({ name }: { name: TSyscallName }) => {
      return calls.filter((call) => {
        return call.name === name;
      }).map((call) => {
        return call.args;
      });
    },
    queueIncoming: ({ datagram }: { datagram: Uint8Array | { errno: number } }) => {
      incoming = [...incoming, datagram];
    },
    // queues the result of the next call, undefined lets that call succeed
    failNext: ({ name, errno }: { name: TSyscallName, errno: number | undefined }) => {
      failures = { ...failures, [name]: [...(failures[name] ?? []), errno] };
    },
    assignPid: ({ pid }: { pid: number }) => {
      assignedPid = pid;
    },
  };
};

type TArmedEvents = Parameters<TPoller["armOnce"]>[0];

/**
 * A poller that is triggered by the test instead of the event loop.
 */
const createFakePoller = () => {
  let armed: TArmedEvents | undefined;
  let closed = false;
  let createdFor: number | undefined;
  let createError: Error | undefined;

  const createPoller: TCreatePoller = ({ fd }) => {
    if (createError !== undefined) {
      throw createError;
    }

    createdFor = fd;

    return {
      armOnce: (events) => {
        armed = events;
      },
      close: () => {
        closed = true;
        armed = undefined;
      },
    };
  };

  const takeArmed = () => {
    const events = armed;
    armed = undefined;

    if (events === undefined) {
      throw Error("poller is not armed");
    }

    return events;
  };

  return {
    createPoller,

    isArmed: () => {
      return armed !== undefined;
    },
    isClosed: () => {
      return closed;
    },
    fdOfPoller: () => {
      return createdFor;
    },
    failCreation: ({ error }: { error: Error }) => {
      createError = error;
    },
    triggerReadable: () => {
      takeArmed().readable();
    },
    triggerError: ({ errorCode }: { errorCode: number }) => {
      takeArmed().error({ errorCode });
    },
  };
};

type TTransportArgs = Parameters<TNetlinkTransportFactory>[0];

/**
 * A transport that records sent datagrams and lets the test deliver received ones.
 */
const createFakeTransport = () => {
  let sent: Uint8Array[] = [];
  let openedWith: TTransportArgs | undefined;
  let closeCount = 0;
  let sendError: Error | undefined;

  const transportFactory: TNetlinkTransportFactory = (args) => {
    openedWith = args;

    const transport: TNetlinkTransport = {
      address: { nl_pid: 4711n, nl_groups: args.address.nl_groups },
      send: ({ data }) => {
        if (sendError !== undefined) {
          throw sendError;
        }

        sent = [...sent, data];
      },
      close: () => {
        closeCount += 1;
      },
    };

    return transport;
  };

  const opened = () => {
    if (openedWith === undefined) {
      throw Error("transport was not opened");
    }

    return openedWith;
  };

  return {
    transportFactory,

    opened,
    sentDatagrams: () => {
      return sent;
    },
    closeCount: () => {
      return closeCount;
    },
    failSend: ({ error }: { error: Error | undefined }) => {
      sendError = error;
    },
    deliver: ({ data }: { data: Uint8Array }) => {
      opened().onData({ data });
    },
    raise: ({ error }: { error: Error }) => {
      opened().onError({ error });
    },
  };
};

export {
  createFakePo6,
  createFakePoller,
  createFakeTransport,
};
