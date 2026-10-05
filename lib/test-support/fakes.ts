import {
  createKernelAbiFor,
  createPo6Api,
  hostAbi,
  type TLinuxKernelInterface,
  type TMemoryInterface
} from "po6";
import type { TNetlinkTransport } from "../netlink-socket.ts";
import type { TCreatePoller, TPo6NetlinkSyscalls, TPoller } from "../po6-transport.ts";
import { formatNetlinkAddress } from "../structures.ts";

const kernelAbi = createKernelAbiFor({ machineAbi: hostAbi });
const { errnoCodes } = kernelAbi;

// only used for its error formatting, which needs neither syscalls nor memory
const { createErrorFromErrno } = createPo6Api({
  kernelInterface: {} as TLinuxKernelInterface,
  kernelAbi,
  memory: {} as TMemoryInterface,
});

type TSyscallName = "getsockname" | "sendmsg" | "recvmsg";

type TCall = {
  name: TSyscallName;
  args: Record<string, unknown>;
};

/**
 * A fake kernel for a single netlink socket.
 * Datagrams in `incoming` are returned by recvmsg(), `failNext` sets the result of the next call of a syscall.
 */
const createFakePo6 = () => {
  const fd = 42;

  let calls: TCall[] = [];
  let incoming: (Uint8Array | { errno: number })[] = [];
  let failures: Partial<Record<TSyscallName, (number | undefined)[]>> = {};
  let sockname = formatNetlinkAddress({ address: { nl_pid: 4711n, nl_groups: 0n } });

  const record = ({ name, args }: TCall) => {
    calls = [...calls, { name, args }];

    const [errno, ...remaining] = failures[name] ?? [];
    failures = { ...failures, [name]: remaining };
    return errno;
  };

  const getsockname: TPo6NetlinkSyscalls["getsockname"] = (args) => {
    const errno = record({ name: "getsockname", args });
    return errno === undefined ? { errno, sockaddr: sockname.slice() } : { errno, sockaddr: undefined };
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

  const po6: TPo6NetlinkSyscalls = {
    getsockname,
    sendmsg,
    recvmsg,
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
    setSockname: ({ sockaddr }: { sockaddr: Uint8Array }) => {
      sockname = sockaddr;
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

  const createPoller: TCreatePoller = ({ fd }) => {
    createdFor = fd;

    return {
      armOnce: (events) => {
        armed = events;
      },
      close: () => {
        if (closed) {
          throw Error("already closed");
        }

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
    triggerReadable: () => {
      takeArmed().readable();
    },
    triggerError: ({ errorCode }: { errorCode: number }) => {
      takeArmed().error({ errorCode });
    },
  };
};

type TListenArgs = Parameters<TNetlinkTransport["listen"]>[0];

/**
 * A transport that records sent datagrams and lets the test deliver received ones.
 */
const createFakeTransport = ({ nl_groups = 0n }: { nl_groups?: bigint } = {}) => {
  let sent: Uint8Array[] = [];
  let listener: TListenArgs | undefined;
  let stopCount = 0;
  let sendError: Error | undefined;

  const transport: TNetlinkTransport = {
    address: { nl_pid: 4711n, nl_groups },
    send: ({ data }) => {
      if (sendError !== undefined) {
        throw sendError;
      }

      sent = [...sent, data];
    },
    listen: (args) => {
      listener = args;

      return {
        stop: () => {
          stopCount += 1;
        },
      };
    },
  };

  const listening = () => {
    if (listener === undefined) {
      throw Error("nobody listens on the transport");
    }

    return listener;
  };

  return {
    transport,

    sentDatagrams: () => {
      return sent;
    },
    stopCount: () => {
      return stopCount;
    },
    failSend: ({ error }: { error: Error | undefined }) => {
      sendError = error;
    },
    deliver: ({ data }: { data: Uint8Array }) => {
      listening().onData({ data });
    },
    raise: ({ error }: { error: Error }) => {
      listening().onError({ error });
    },
  };
};

export {
  createFakePo6,
  createFakePoller,
  createFakeTransport,
};
