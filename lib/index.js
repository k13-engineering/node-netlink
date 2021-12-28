import socket from "po6-socket";
import EventEmitter from "events";

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

const open = ({ family, pid, groups }) => {
  const emitter = new EventEmitter();

  return socket
    .create({
      domain: AF_NETLINK,
      type: SOCK_DGRAM,
      protocol: BigInt(family),
    })
    .then((sock) => {
      const netlinkAddress = structures.sockaddr_nl.format({
        nl_family: AF_NETLINK,
        nl_pid: BigInt(pid || 0),
        nl_groups: BigInt(groups || 0),
      });

      const close = () => {
        return sock.close();
      };

      sock.on("message", ({ data }) => {
        const parsedPackets = netlinkParser.parseMessage({ message: data });

        parsedPackets.forEach((packet) => {
          emitter.emit("message", packet);
        });
      });

      let seq = 1n;

      const send = ({ header: requestedHeader, payload }) => {
        let header = Object.assign({}, requestedHeader);

        if (header.nlmsg_seq === undefined) {
          header = Object.assign({}, header, {
            nlmsg_seq: seq,
          });
          seq += 1n;
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

        return sock.sendmsg({
          data,
          msghdr: {
            msg_name: destBuffer,
          },
        });
      };

      let requested = {};

      const maybeAppendMessageToResponse = ({ message }) => {
        const { header } = message;

        if (header.nlmsg_type === NLMSG_DONE) {
          return;
        }

        requested = {
          [header.nlmsg_seq]: {
            ...requested[header.nlmsg_seq],
            msgs: [...(requested[header.nlmsg_seq]?.msgs || []), message],
          },
        };
      };

      const maybeFinishRequest = ({ message }) => {
        const { header } = message;
        const req = requested[header.nlmsg_seq];

        const isLast =
          header.nlmsg_type === NLMSG_ERROR || header.nlmsg_type === NLMSG_DONE;

        if (isLast) {
          clearTimeout(req.schedule);
          req.resolve(req.msgs);

          const { [header.nlmsg_seq]: unused, ...other } = requested;
          requested = other;
        }
      };

      const processResponse = ({ message }) => {
        const { header } = message;
        const req = requested[header.nlmsg_seq];

        if (!req) {
          console.warn(
            `could not find pending request for seq=${header.nlmsg_seq}`
          );
          console.warn(`nlmsg_type = ${header.nlmsg_type}`);

          return;
        }

        maybeAppendMessageToResponse({ message });
        maybeFinishRequest({ message });
      };

      emitter.on("message", (message) => {
        const { header } = message;

        if (header.nlmsg_flags & NLM_F_REQUEST) {
          return;
        }

        if (header.nlmsg_seq === 0) {
          return;
        }

        processResponse({ message });
      });

      const tryTalk = (message, { timeout = 10000 } = {}) => {
        if (!(message.header.nlmsg_flags & NLM_F_ACK)) {
          throw new Error(`talk only supports requests with NLM_F_ACK set`);
        }

        return Promise.resolve()
          .then(() => {
            return new Promise((resolve, reject) => {
              const header = Object.assign({}, message.header, {
                nlmsg_seq: seq,
              });
              seq += 1n;

              const schedule = setTimeout(() => {
                const { [header.nlmsg_seq]: unused, ...other } = requested;
                requested = other;

                reject(new Error("timeout reached"));
              }, timeout);

              requested = {
                ...requested,
                [header.nlmsg_seq]: {
                  msgs: [],
                  schedule,
                  resolve,
                },
              };

              send({
                header,
                payload: message.payload,
              }).catch(reject);
            });
          })
          .then((packets) => {
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
              packets: packetsWithoutError,
            };
          });
      };

      const talk = (obj, options) => {
        return tryTalk(obj, options).then(({ errorCode, packets }) => {
          if (errorCode !== 0) {
            throw errorFactory.createFromErrorCode({ errorCode });
          }

          return packets;
        });
      };

      return sock
        .bind({
          sockaddr: netlinkAddress,
        })
        .then(() => {
          return sock.getsockname();
        })
        .then((actualAddressBuffer) => {
          const { nl_pid } = structures.sockaddr_nl.parse(actualAddressBuffer);

          return {
            nl_pid,

            talk,
            tryTalk,
            close,
            on: emitter.on.bind(emitter),
          };
        });
    });
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
  createErrorFromErrorCode: errorFactory.createFromErrorCode,
};
