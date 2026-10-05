import { NLM_F_ACK, NLM_F_REQUEST } from "./constants.ts";
import {
  errnoOfMessage,
  formatMessage,
  isTerminatingMessage,
  parseMessages,
  type TNetlinkMessage
} from "./message.ts";
import type { TNetlinkStructures } from "./structures.ts";

type TNetlinkAddress = {
  nl_pid: bigint;
  nl_groups: bigint;
};

/**
 * A bound netlink socket that sends and receives raw datagrams.
 *
 * This is the seam between the netlink protocol handling and the operating system.
 * `createPo6TransportFactory()` provides the implementation on top of real sockets,
 * tests can inject fakes instead.
 */
type TNetlinkTransport = {
  // the address the socket is bound to, as reported by getsockname()
  address: TNetlinkAddress;
  // sends a datagram to the kernel, throws on failure
  send: (args: { data: Uint8Array }) => void;
  // closes the socket, no callbacks are called afterwards
  close: () => void;
};

type TNetlinkTransportFactory = (args: {
  family: bigint;
  // requested address, nl_pid 0 lets the kernel assign a port id
  address: TNetlinkAddress;
  onData: (args: { data: Uint8Array }) => void;
  onError: (args: { error: Error }) => void;
}) => TNetlinkTransport;

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_SEQ = 0xFFFF_FFFFn;

type TRequestHeader = {
  nlmsg_type: bigint;
  nlmsg_flags?: bigint;
};

type TSendHeader = TRequestHeader & {
  nlmsg_seq?: bigint;
  nlmsg_pid?: bigint;
};

type TTalkArgs = {
  header: TRequestHeader;
  payload: Uint8Array;
  timeoutMs?: number;
};

type TTryTalkResult = {
  // undefined if the request succeeded
  errno: number | undefined;
  // all responses except the terminating NLMSG_ERROR or NLMSG_DONE
  messages: TNetlinkMessage[];
};

type TNetlinkSocket = {
  // port id the socket is bound to
  nl_pid: bigint;
  // multicast groups the socket is bound to
  nl_groups: bigint;

  // sends a message without waiting for a response, returns the sequence number used
  send: (args: { header: TSendHeader, payload: Uint8Array }) => { nlmsg_seq: bigint };
  // sends a request and resolves with all responses, or the errno the kernel reported
  tryTalk: (args: TTalkArgs) => Promise<TTryTalkResult>;
  // like tryTalk, but rejects if the kernel reported an error
  talk: (args: TTalkArgs) => Promise<TNetlinkMessage[]>;
  // closes the socket, pending requests are rejected
  close: () => void;
};

type TOpenArgs = {
  family: bigint;
  nl_pid?: bigint;
  nl_groups?: bigint;
  // called for every received message that is not a response to a pending request
  onMessage?: (args: { message: TNetlinkMessage }) => void;
  // called for errors while receiving, if omitted such errors are thrown asynchronously
  onError?: (args: { error: Error }) => void;
};

type TNetlinkDependencies = {
  transportFactory: TNetlinkTransportFactory;
  structures: TNetlinkStructures;
  createErrorFromErrno: (args: { operation: string, errno: number }) => Error;
  reportUnhandledError: (args: { error: Error }) => void;
};

type TPendingRequest = {
  messages: TNetlinkMessage[];
  resolve: (result: TTryTalkResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

// sequence numbers are 32 bit, 0 is skipped as it is used by notifications
const seqAfter = ({ seq }: { seq: bigint }) => {
  return seq === MAX_SEQ ? 1n : seq + 1n;
};

// requests sent to us by other sockets are never responses, even if their sequence number matches
const isRequest = ({ message }: { message: TNetlinkMessage }) => {
  return (message.header.nlmsg_flags & NLM_F_REQUEST) !== 0n;
};

const createNetlink = ({ transportFactory, structures, createErrorFromErrno, reportUnhandledError }: TNetlinkDependencies) => {

  // eslint-disable-next-line max-statements
  const open = ({ family, nl_pid = 0n, nl_groups = 0n, onMessage, onError }: TOpenArgs): TNetlinkSocket => {

    let closed = false;
    let nextSeq = 1n;
    let pendingRequests: Record<string, TPendingRequest> = {};

    const handleError = ({ error }: { error: Error }) => {
      if (onError === undefined) {
        reportUnhandledError({ error });
        return;
      }

      onError({ error });
    };

    const removePendingRequest = ({ seq }: { seq: bigint }) => {
      const { [seq.toString()]: request, ...otherRequests } = pendingRequests;
      pendingRequests = otherRequests;

      clearTimeout(request.timeout);
      return request;
    };

    const finishRequest = ({ request, message }: { request: TPendingRequest, message: TNetlinkMessage }) => {
      let errno: number | undefined;

      try {
        errno = errnoOfMessage({ message, structures });
      } catch (ex) {
        request.reject(ex as Error);
        return;
      }

      request.resolve({ errno, messages: request.messages });
    };

    const deliverUnsolicited = ({ message }: { message: TNetlinkMessage }) => {
      if (onMessage !== undefined) {
        onMessage({ message });
      }
    };

    const dispatchMessage = ({ message }: { message: TNetlinkMessage }) => {
      const { nlmsg_seq } = message.header;
      const request = pendingRequests[nlmsg_seq.toString()];

      if (request === undefined || isRequest({ message })) {
        deliverUnsolicited({ message });
        return;
      }

      if (!isTerminatingMessage({ message })) {
        pendingRequests = {
          ...pendingRequests,
          [nlmsg_seq.toString()]: { ...request, messages: [...request.messages, message] },
        };
        return;
      }

      removePendingRequest({ seq: nlmsg_seq });
      finishRequest({ request, message });
    };

    const onData = ({ data }: { data: Uint8Array }) => {
      let messages: TNetlinkMessage[];

      try {
        messages = parseMessages({ data, structures });
      } catch (ex) {
        handleError({ error: ex as Error });
        return;
      }

      // a handler may close the socket, the remaining messages are dropped then
      messages.forEach((message) => {
        if (!closed) {
          dispatchMessage({ message });
        }
      });
    };

    const transport = transportFactory({
      family,
      address: { nl_pid, nl_groups },
      onData,
      onError: handleError,
    });

    const allocateSeq = () => {
      const seq = nextSeq;
      nextSeq = seqAfter({ seq });
      return seq;
    };

    const assertOpen = () => {
      if (closed) {
        throw Error("netlink socket is closed");
      }
    };

    const send: TNetlinkSocket["send"] = ({ header, payload }) => {
      assertOpen();

      const {
        nlmsg_type,
        nlmsg_flags = NLM_F_REQUEST,
        nlmsg_seq = allocateSeq(),
        nlmsg_pid: messagePid = 0n,
      } = header;

      const data = formatMessage({
        message: {
          header: { nlmsg_type, nlmsg_flags, nlmsg_seq, nlmsg_pid: messagePid },
          payload,
        },
        structures,
      });

      transport.send({ data });

      return { nlmsg_seq };
    };

    const tryTalk: TNetlinkSocket["tryTalk"] = ({ header, payload, timeoutMs = DEFAULT_TIMEOUT_MS }) => {
      return new Promise((resolve, reject) => {
        assertOpen();

        const seq = allocateSeq();

        const timeout = setTimeout(() => {
          removePendingRequest({ seq });
          reject(Error(`netlink request timed out after ${timeoutMs} ms`));
        }, timeoutMs);

        pendingRequests = {
          ...pendingRequests,
          [seq.toString()]: { messages: [], resolve, reject, timeout },
        };

        try {
          send({
            header: {
              nlmsg_type: header.nlmsg_type,
              nlmsg_flags: (header.nlmsg_flags ?? 0n) | NLM_F_REQUEST | NLM_F_ACK,
              nlmsg_seq: seq,
            },
            payload,
          });
        } catch (ex) {
          removePendingRequest({ seq });
          throw ex;
        }
      });
    };

    const talk: TNetlinkSocket["talk"] = async (args) => {
      const { errno, messages } = await tryTalk(args);

      if (errno !== undefined) {
        throw createErrorFromErrno({ operation: `netlink request of type ${args.header.nlmsg_type}`, errno });
      }

      return messages;
    };

    const close = () => {
      if (closed) {
        return;
      }

      closed = true;

      const requests = Object.values(pendingRequests);
      pendingRequests = {};

      requests.forEach((request) => {
        clearTimeout(request.timeout);
        request.reject(Error("netlink socket was closed while waiting for a response"));
      });

      transport.close();
    };

    return {
      nl_pid: transport.address.nl_pid,
      nl_groups: transport.address.nl_groups,

      send,
      tryTalk,
      talk,
      close,
    };
  };

  return {
    open,
  };
};

export {
  createNetlink,
  seqAfter,
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
};
