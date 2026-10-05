import type { TPo6Api, TPo6KernelAbi } from "po6";
import { AF_NETLINK } from "./constants.ts";
import type { TNetlinkAddress, TNetlinkTransport } from "./netlink-socket.ts";
import { formatNetlinkAddress, hostStructures, type TNetlinkStructures } from "./structures.ts";

type TPo6NetlinkSyscalls = Pick<TPo6Api, "getsockname" | "sendmsg" | "recvmsg" | "createErrorFromErrno">;

type TPoller = {
  armOnce: (events: {
    readable: () => void;
    error: (args: { errorCode: number }) => void;
  }) => void;
  close: () => void;
};

type TCreatePoller = (args: { fd: number }) => TPoller;

type TCreatePo6NetlinkTransportArgs = {
  // a netlink socket opened and bound by the caller, who also closes it
  fd: number;
  po6: TPo6NetlinkSyscalls;
  kernelAbi: Pick<TPo6KernelAbi, "constants" | "errnoCodes">;
  createPoller: TCreatePoller;
  structures?: TNetlinkStructures;
};

type TReceiveResult = {
  errno: number;
  data: undefined;
} | {
  errno: undefined;
  data: Uint8Array;
};

/**
 * Adapts a netlink socket file descriptor to a transport, using the given po6 syscalls and poller.
 * The socket is neither opened nor closed here, it is owned by the caller.
 */
const createPo6NetlinkTransport = ({
  fd,
  po6,
  kernelAbi,
  createPoller,
  structures = hostStructures,
}: TCreatePo6NetlinkTransportArgs): TNetlinkTransport => {

  const { MSG_DONTWAIT, MSG_PEEK, MSG_TRUNC } = kernelAbi.constants;
  const { EAGAIN, ENOBUFS } = kernelAbi.errnoCodes;

  const queryAddress = (): TNetlinkAddress => {
    const { errno, sockaddr } = po6.getsockname({ fd });

    if (errno !== undefined) {
      throw po6.createErrorFromErrno({ operation: "getsockname()", errno });
    }

    const { nl_family, nl_pid, nl_groups } = structures.sockaddrNl.parse({ data: sockaddr });

    if (nl_family !== AF_NETLINK) {
      throw Error(`file descriptor ${fd} is not a netlink socket, its address family is ${nl_family}`);
    }

    return { nl_pid, nl_groups };
  };

  const address = queryAddress();
  const kernelAddress = formatNetlinkAddress({ address: { nl_pid: 0n, nl_groups: 0n }, structures });

  const receiveDatagram = (): TReceiveResult => {
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

  const send: TNetlinkTransport["send"] = ({ data }) => {
    const { errno } = po6.sendmsg({ fd, data, msghdr: { msg_name: kernelAddress } });

    if (errno !== undefined) {
      throw po6.createErrorFromErrno({ operation: "sendmsg()", errno });
    }
  };

  const listen: TNetlinkTransport["listen"] = ({ onData, onError }) => {
    const poller = createPoller({ fd });
    let stopped = false;

    const receiveAndDispatch = (): "continue" | "wait" | "stop" => {
      const { errno, data } = receiveDatagram();

      if (errno === undefined) {
        onData({ data });
        return "continue";
      }

      if (errno === EAGAIN) {
        return "wait";
      }

      onError({ error: po6.createErrorFromErrno({ operation: "recvmsg()", errno }) });

      // ENOBUFS: the receive buffer overflowed and messages were lost, the socket is still usable
      return errno === ENOBUFS ? "continue" : "stop";
    };

    // receives until the socket is empty, returns whether to wait for more data
    const drain = () => {
      let state = receiveAndDispatch();

      while (state === "continue" && !stopped) {
        state = receiveAndDispatch();
      }

      return state === "wait" && !stopped;
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

    arm();

    return {
      stop: () => {
        if (stopped) {
          return;
        }

        stopped = true;
        poller.close();
      },
    };
  };

  return {
    address,
    send,
    listen,
  };
};

export {
  createPo6NetlinkTransport,
};

export type {
  TPo6NetlinkSyscalls,
  TPoller,
  TCreatePoller,
  TCreatePo6NetlinkTransportArgs,
};
