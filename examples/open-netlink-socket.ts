// Shared setup of the examples: the application opens and binds the netlink socket with po6,
// node-netlink only speaks the protocol on top of it.

import { createPoller } from "@k13engineering/uv-poll";
import { pinBuffer } from "buffer2address";
import {
  createKernelAbiFor,
  createLinuxKernelInterface,
  createPo6Api,
  hostAbi
} from "po6";
import { syscall, syscallNumbers } from "syscall-napi";
import {
  AF_NETLINK,
  createNetlinkSocket,
  createPo6NetlinkTransport,
  formatNetlinkAddress,
  type TCreateNetlinkSocketArgs
} from "../lib/index.ts";

// <linux/net.h> and <asm-generic/fcntl.h>
const SOCK_RAW = 3n;
const SOCK_CLOEXEC = 0o2000000n;

const kernelAbi = createKernelAbiFor({ machineAbi: hostAbi });

const po6 = createPo6Api({
  kernelInterface: createLinuxKernelInterface({ syscall, syscallNumbers }),
  kernelAbi,
  memory: { pinBuffer },
});

const throwOnErrno = ({ operation, errno }: { operation: string, errno: number | undefined }) => {
  if (errno !== undefined) {
    throw po6.createErrorFromErrno({ operation, errno });
  }
};

const openNetlinkSocket = ({ family, nl_groups = 0n, ...socketArgs }: {
  family: bigint,
  nl_groups?: bigint,
} & Omit<TCreateNetlinkSocketArgs, "transport">) => {
  const { errno, fd } = po6.socket({ domain: AF_NETLINK, type: SOCK_RAW | SOCK_CLOEXEC, protocol: family });
  throwOnErrno({ operation: "socket()", errno });

  const { errno: bindErrno } = po6.bind({
    fd: fd as number,
    sockaddr: formatNetlinkAddress({ address: { nl_pid: 0n, nl_groups } }),
  });
  throwOnErrno({ operation: "bind()", errno: bindErrno });

  const transport = createPo6NetlinkTransport({ fd: fd as number, po6, kernelAbi, createPoller });
  const socket = createNetlinkSocket({ transport, ...socketArgs });

  const close = () => {
    socket.detach();
    po6.close({ fd: fd as number });
  };

  return { socket, close };
};

export {
  openNetlinkSocket,
};
