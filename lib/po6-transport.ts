import type { TPo6Api, TPo6KernelAbi } from "po6";
import { AF_NETLINK } from "./constants.ts";
import type { TNetlinkStructures } from "./structures.ts";
import type { TNetlinkAddress, TNetlinkTransportFactory } from "./netlink-socket.ts";

// <linux/net.h> and <asm-generic/fcntl.h>, the same on x86, arm and arm64
const SOCK_DGRAM = 2n;
const SOCK_NONBLOCK = 0o4000n;
const SOCK_CLOEXEC = 0o2000000n;

type TPo6NetlinkSyscalls = Pick<TPo6Api, "socket" | "bind" | "getsockname" | "sendmsg" | "recvmsg" | "close" | "createErrorFromErrno">;

type TPoller = {
  armOnce: (events: {
    readable: () => void;
    error: (args: { errorCode: number }) => void;
  }) => void;
  close: () => void;
};

type TCreatePoller = (args: { fd: number }) => TPoller;

type TPo6TransportDependencies = {
  po6: TPo6NetlinkSyscalls;
  kernelAbi: Pick<TPo6KernelAbi, "constants" | "errnoCodes">;
  createPoller: TCreatePoller;
  structures: TNetlinkStructures;
};

type TReceiveResult = {
  errno: number;
  data: undefined;
} | {
  errno: undefined;
  data: Uint8Array;
};

const createPo6TransportFactory = ({ po6, kernelAbi, createPoller, structures }: TPo6TransportDependencies): TNetlinkTransportFactory => {

  const { MSG_DONTWAIT, MSG_PEEK, MSG_TRUNC } = kernelAbi.constants;
  const { EAGAIN, ENOBUFS } = kernelAbi.errnoCodes;

  const throwOnErrno = ({ operation, errno }: { operation: string, errno: number | undefined }) => {
    if (errno !== undefined) {
      throw po6.createErrorFromErrno({ operation, errno });
    }
  };

  const formatAddress = ({ address }: { address: TNetlinkAddress }) => {
    return structures.sockaddrNl.format({
      value: {
        nl_family: AF_NETLINK,
        nl_pad: 0n,
        ...address,
      }
    });
  };

  const kernelAddress = formatAddress({ address: { nl_pid: 0n, nl_groups: 0n } });

  const bindAndQueryAddress = ({ fd, address }: { fd: number, address: TNetlinkAddress }): TNetlinkAddress => {
    const { errno: bindErrno } = po6.bind({ fd, sockaddr: formatAddress({ address }) });
    throwOnErrno({ operation: "bind()", errno: bindErrno });

    const { errno: getsocknameErrno, sockaddr } = po6.getsockname({ fd });
    throwOnErrno({ operation: "getsockname()", errno: getsocknameErrno });

    const { nl_pid, nl_groups } = structures.sockaddrNl.parse({ data: sockaddr as Uint8Array });
    return { nl_pid, nl_groups };
  };

  const receiveDatagram = ({ fd }: { fd: number }): TReceiveResult => {
    // with MSG_TRUNC, netlink reports the full length of the datagram, even if the buffer is smaller
    const { errno: peekErrno, bytesReceived: datagramLength } = po6.recvmsg({
      fd,
      data: new Uint8Array(1),
      flags: MSG_PEEK | MSG_TRUNC | MSG_DONTWAIT,
    });

    if (peekErrno !== undefined) {
      return { errno: peekErrno, data: undefined };
    }

    const data = new Uint8Array(Math.max(datagramLength, 1));
    const { errno, bytesReceived } = po6.recvmsg({ fd, data, flags: MSG_DONTWAIT });

    if (errno !== undefined) {
      return { errno, data: undefined };
    }

    return { errno: undefined, data: data.subarray(0, bytesReceived) };
  };

  // eslint-disable-next-line max-statements
  return ({ family, address: requestedAddress, onData, onError }) => {
    const { errno: socketErrno, fd } = po6.socket({
      domain: AF_NETLINK,
      type: SOCK_DGRAM | SOCK_NONBLOCK | SOCK_CLOEXEC,
      protocol: family,
    });

    if (socketErrno !== undefined) {
      throw po6.createErrorFromErrno({ operation: "socket()", errno: socketErrno });
    }

    let address: TNetlinkAddress;
    let poller: TPoller;

    try {
      address = bindAndQueryAddress({ fd, address: requestedAddress });
      poller = createPoller({ fd });
    } catch (ex) {
      po6.close({ fd });
      throw ex;
    }

    let closed = false;

    const reportErrno = ({ errno }: { errno: number }) => {
      onError({ error: po6.createErrorFromErrno({ operation: "recvmsg()", errno }) });
    };

    const receiveAndDispatch = (): "continue" | "wait" | "stop" => {
      const { errno, data } = receiveDatagram({ fd });

      if (errno === undefined) {
        onData({ data });
        return "continue";
      }

      if (errno === EAGAIN) {
        return "wait";
      }

      reportErrno({ errno });

      // ENOBUFS: the receive buffer overflowed and messages were lost, the socket is still usable
      return errno === ENOBUFS ? "continue" : "stop";
    };

    // receives until the socket is empty, returns whether to wait for more data
    const drain = () => {
      let state = receiveAndDispatch();

      while (state === "continue" && !closed) {
        state = receiveAndDispatch();
      }

      return state === "wait" && !closed;
    };

    const arm = () => {
      poller.armOnce({
        readable: () => {
          if (drain()) {
            arm();
          }
        },
        error: ({ errorCode }) => {
          onError({ error: Error(`polling netlink socket failed with libuv error ${errorCode}`) });
        },
      });
    };

    const send = ({ data }: { data: Uint8Array }) => {
      const { errno } = po6.sendmsg({ fd, data, msghdr: { msg_name: kernelAddress } });
      throwOnErrno({ operation: "sendmsg()", errno });
    };

    const close = () => {
      closed = true;
      poller.close();

      const { errno } = po6.close({ fd });
      throwOnErrno({ operation: "close()", errno });
    };

    arm();

    return {
      address,
      send,
      close,
    };
  };
};

export {
  createPo6TransportFactory,
};

export type {
  TPo6NetlinkSyscalls,
  TPoller,
  TCreatePoller,
  TPo6TransportDependencies,
};
