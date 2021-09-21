/* eslint-disable max-statements */
/* eslint-disable complexity */

import socket from "../../node-posix-socket-libjs/lib/index.js";
import EventEmitter from "events";
import assert from "assert";

import structures from "./structures.js";
import netlinkParser from "./parser.js";
import errorFactory from "./error.js";

const AF_NETLINK = 16n;
const SOCK_DGRAM = 2n;

const NLM_F_ECHO = 8n;
const NLM_F_REQUEST = 1n;
const NLM_F_MULTI = 2n;
const NLM_F_MATCH = 0x200n;
const NLM_F_DUMP = 0x300n;
const NLM_F_ACK = 4n;
const NLM_F_CREATE = 0x400n;
const NLM_F_EXCL = 0x200n;

const NLMSG_ERROR = 2n;
const NLMSG_DONE = 3n;

const MSG_PEEK = 0x02n;
const MSG_TRUNC = 0x20n;

const open = async ({ family, pid, groups }) => {
  const emitter = new EventEmitter();

  const sock = await socket.create({
    domain: AF_NETLINK,
    type: SOCK_DGRAM,
    protocol: BigInt(family),
  });

  const netlinkAddress = structures.sockaddr_nl.format({
    nl_family: AF_NETLINK,
    nl_pid: BigInt(pid || 0),
    nl_groups: BigInt(groups || 0),
  });

  await sock.bind({
    sockaddr: netlinkAddress,
  });

  const actualAddressBuffer = await sock.getsockname();

  const { nl_pid } = structures.sockaddr_nl.parse(actualAddressBuffer);
  // const { nl_pid } = actualAddress.read();
  // console.log("nl_pid =", nl_pid);

  const close = () => {
    return sock.close();
  };

  sock.on("message", (message) => {
    const parsedPackets = netlinkParser.parseMessage({ message });

    parsedPackets.forEach((packet) => {
      emitter.emit("message", packet);
    });
  });

  let seq = 1n;

  const send = async ({ header: requestedHeader, payload }) => {
    let header = Object.assign({}, requestedHeader);

    if (header.nlmsg_seq === undefined) {
      header = Object.assign({}, header, {
        nlmsg_seq: seq,
      });
      seq += 1;
    }

    if (header.nlmsg_pid === undefined) {
      header = Object.assign({}, header, {
        // "nlmsg_pid": nl_pid
      });
    }

    header = Object.assign({}, header, {
      nlmsg_len: BigInt(structures.nlmsghdr.size) + BigInt(payload.length),
    });

    const headerAsBuf = structures.nlmsghdr.format(header);

    const data = Buffer.concat([headerAsBuf, payload]);

    const destBuffer = structures.sockaddr_nl.format({
      nl_family: AF_NETLINK,
    });

    // TODO: flags

    await sock.sendmsg({
      data,
      msghdr: {
        msg_name: destBuffer,
      },
    });
  };

  let requested = {};

  // const readNextMessage = async () => {
  //   try {
  //     const { "bytesReceived": availableBytes } = await sock.recvmsg({
  //       "data": Buffer.alloc(0),
  //       "flags": MSG_PEEK | MSG_TRUNC
  //     });
  //
  //     const { data, bytesReceived } = await sock.recvmsg({
  //       "data": Buffer.alloc(availableBytes)
  //     });
  //
  //     const message = data.slice(0, bytesReceived);
  //     // console.log("message =", message);
  //
  //     const parsedPackets = netlinkParser.parseMessage({ message });
  //
  //     parsedPackets.forEach((packet) => {
  //       emitter.emit("message", packet);
  //     });
  //
  //     // console.log("parsedPackets =", parsedPackets);
  //
  //     // emitter.emit("message", msg);
  //     if (!closed) {
  //       readNextMessage();
  //     }
  //   } catch (ex) {
  //     console.error(ex);
  //     emitter.emit("error", ex);
  //   }
  // };
  // readNextMessage();

  emitter.on("message", (message) => {
    const { header } = message;

    if (header.nlmsg_flags & NLM_F_REQUEST) {
      return;
    }

    if (header.nlmsg_seq === 0) {
      return;
    }

    const req = requested[header.nlmsg_seq];

    if (req) {
      const isLast =
        header.nlmsg_type === NLMSG_ERROR || header.nlmsg_type === NLMSG_DONE;

      if (header.nlmsg_type !== NLMSG_DONE) {
        req.msgs = [...req.msgs, message];
      }

      if (isLast) {
        clearTimeout(req.schedule);
        req.resolve(req.msgs);
        Reflect.deleteProperty(requested, header.nlmsg_seq);
      }
    } else {
      console.warn(
        `could not find pending request for seq=${header.nlmsg_seq}`
      );
      console.warn(`nlmsg_type = ${header.nlmsg_type}`);
    }
  });

  const tryTalk = async (message, { timeout = 10000 } = {}) => {
    if (!(message.header.nlmsg_flags & NLM_F_ACK)) {
      throw new Error(`talk only supports requests with NLM_F_ACK set`);
    }

    const packets = await new Promise((resolve, reject) => {
      const header = Object.assign({}, message.header, {
        nlmsg_seq: seq,
      });
      seq += 1n;

      const schedule = setTimeout(() => {
        Reflect.deleteProperty(requested, header.nlmsg_seq);
        reject(new Error("timeout reached"));
      }, timeout);

      requested[header.nlmsg_seq] = {
        msgs: [],
        schedule,
        resolve,
      };

      send({
        header,
        payload: message.payload,
      }).catch(reject);
    });

    let errorCode = 0;

    const packetsWithoutError = packets.filter((pkt) => {
      if (pkt.header.nlmsg_type === NLMSG_ERROR) {
        const packetErrorCode = pkt.payload.readInt32LE(0);
        if (packetErrorCode !== 0) {
          errorCode = -packetErrorCode;
        }
        return false;
      } else {
        return true;
      }
    });

    return {
      errorCode,
      packets: packetsWithoutError
    };
  };

  const talk = async (obj, options) => {
    const { errorCode, packets } = await tryTalk(obj, options);
    if (errorCode !== 0) {
      throw errorFactory.createFromErrorCode({ errorCode });
    }

    return packets;
  };

  return {
    talk,
    tryTalk,
    close,
    on: emitter.on.bind(emitter),
  };
};

export default {
  NLM_F_ECHO,
  NLM_F_REQUEST,
  NLM_F_MULTI,
  NLM_F_DUMP,
  NLM_F_ACK,
  NLM_F_CREATE,
  NLM_F_EXCL,
  NLM_F_MATCH,

  NLMSG_DONE,
  NLMSG_ERROR,

  open,
  createErrorFromErrorCode: errorFactory.createFromErrorCode
};
