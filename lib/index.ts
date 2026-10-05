import { createErrorFromErrno } from "./errno.ts";
import { createNetlinkSocket } from "./netlink-socket.ts";
import { createPo6NetlinkTransport } from "./po6-transport.ts";
import { errnoOfMessage, formatMessage, nlmsgAlign, parseMessages } from "./message.ts";
import {
  createNetlinkStructuresFor,
  formatNetlinkAddress,
  hostStructures,
  nlmsgerrDefinition,
  nlmsghdrDefinition,
  sockaddrNlDefinition
} from "./structures.ts";

export * from "./constants.ts";

export {
  createNetlinkSocket,
  createPo6NetlinkTransport,

  parseMessages,
  formatMessage,
  errnoOfMessage,
  nlmsgAlign,
  createErrorFromErrno,

  formatNetlinkAddress,
  createNetlinkStructuresFor,
  hostStructures,
  sockaddrNlDefinition,
  nlmsghdrDefinition,
  nlmsgerrDefinition,
};

export type {
  TNetlinkAddress,
  TNetlinkTransport,
  TNetlinkSocket,
  TCreateNetlinkSocketArgs,
  TTalkArgs,
  TTryTalkResult,
  TRequestHeader,
  TSendHeader,
} from "./netlink-socket.ts";
export type { TNetlinkHeader, TNetlinkMessage } from "./message.ts";
export type { TNetlinkStructures } from "./structures.ts";
export type { TErrorWithErrno } from "./errno.ts";
export type {
  TPo6NetlinkSyscalls,
  TPoller,
  TCreatePoller,
  TCreatePo6NetlinkTransportArgs,
} from "./po6-transport.ts";
