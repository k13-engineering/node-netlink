import { createPoller } from "@k13engineering/uv-poll";
import { pinBuffer } from "buffer2address";
import {
  createKernelAbiFor,
  createLinuxKernelInterface,
  createPo6Api,
  hostAbi
} from "po6";
import { syscall, syscallNumbers } from "syscall-napi";
import { createNetlink } from "./netlink-socket.ts";
import { createPo6TransportFactory } from "./po6-transport.ts";
import { hostStructures } from "./structures.ts";

const kernelAbi = createKernelAbiFor({ machineAbi: hostAbi });

const po6 = createPo6Api({
  kernelInterface: createLinuxKernelInterface({ syscall, syscallNumbers }),
  kernelAbi,
  memory: { pinBuffer },
});

const transportFactory = createPo6TransportFactory({
  po6,
  kernelAbi,
  createPoller,
  structures: hostStructures,
});

// errors without an onError handler must not go unnoticed, so they surface as uncaught exceptions
const reportUnhandledError = ({ error }: { error: Error }) => {
  queueMicrotask(() => {
    throw error;
  });
};

const { open: openNetlinkSocket } = createNetlink({
  transportFactory,
  structures: hostStructures,
  createErrorFromErrno: po6.createErrorFromErrno,
  reportUnhandledError,
});

export {
  openNetlinkSocket,
  transportFactory,
  reportUnhandledError,
};
