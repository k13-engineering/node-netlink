import { createNetlink } from "./netlink-socket.ts";
import { createPo6TransportFactory } from "./po6-transport.ts";
import { errnoOfMessage, formatMessage, nlmsgAlign, parseMessages } from "./message.ts";
import {
  createNetlinkStructuresFor,
  hostStructures,
  nlmsgerrDefinition,
  nlmsghdrDefinition,
  sockaddrNlDefinition
} from "./structures.ts";
import { openNetlinkSocket } from "./system.ts";

export * from "./constants.ts";

export {
  openNetlinkSocket,

  createNetlink,
  createPo6TransportFactory,

  parseMessages,
  formatMessage,
  errnoOfMessage,
  nlmsgAlign,

  createNetlinkStructuresFor,
  hostStructures,
  sockaddrNlDefinition,
  nlmsghdrDefinition,
  nlmsgerrDefinition,
};

export type {
  TNetlinkAddress,
  TNetlinkTransport,
  TNetlinkTransportFactory,
  TNetlinkSocket,
  TOpenArgs,
  TTalkArgs,
  TTryTalkResult,
  TRequestHeader,
  TSendHeader,
  TNetlinkDependencies,
} from "./netlink-socket.ts";
export type { TNetlinkHeader, TNetlinkMessage } from "./message.ts";
export type { TNetlinkStructures } from "./structures.ts";
export type {
  TPo6NetlinkSyscalls,
  TPoller,
  TCreatePoller,
  TPo6TransportDependencies,
} from "./po6-transport.ts";
