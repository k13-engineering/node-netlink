import { NLMSG_DONE, NLMSG_ERROR } from "./constants.ts";
import type { TNetlinkStructures } from "./structures.ts";

type TNetlinkHeader = {
  nlmsg_type: bigint;
  nlmsg_flags: bigint;
  nlmsg_seq: bigint;
  nlmsg_pid: bigint;
};

type TNetlinkMessage = {
  header: TNetlinkHeader;
  payload: Uint8Array;
};

const NLMSG_ALIGNTO = 4;

const nlmsgAlign = ({ length }: { length: number }) => {
  return Math.ceil(length / NLMSG_ALIGNTO) * NLMSG_ALIGNTO;
};

const parseOneMessage = ({ data, structures }: { data: Uint8Array, structures: TNetlinkStructures }) => {
  const headerSize = structures.nlmsghdr.size;

  if (data.length < headerSize) {
    throw Error(`malformed netlink message: ${data.length} bytes left, but a header needs ${headerSize} bytes`);
  }

  const { nlmsg_len, ...header } = structures.nlmsghdr.parse({ data: data.subarray(0, headerSize) });
  const messageLength = Number(nlmsg_len);

  if (messageLength < headerSize || messageLength > data.length) {
    throw Error(`malformed netlink message: nlmsg_len ${messageLength} is out of range [${headerSize}, ${data.length}]`);
  }

  // copy, so the payload does not keep the whole receive buffer alive
  const payload = data.slice(headerSize, messageLength);

  return {
    message: { header, payload },
    space: nlmsgAlign({ length: messageLength }),
  };
};

/**
 * Splits a received datagram into its netlink messages.
 * Throws if the datagram is malformed.
 */
const parseMessages = ({ data, structures }: { data: Uint8Array, structures: TNetlinkStructures }) => {
  let messages: TNetlinkMessage[] = [];
  let remaining = data;

  while (remaining.length > 0) {
    const { message, space } = parseOneMessage({ data: remaining, structures });
    messages = [...messages, message];
    remaining = remaining.subarray(space);
  }

  return messages;
};

/**
 * Formats a netlink message, nlmsg_len is calculated from the payload.
 */
const formatMessage = ({ message, structures }: { message: TNetlinkMessage, structures: TNetlinkStructures }) => {
  const { header, payload } = message;

  const headerAsBuffer = structures.nlmsghdr.format({
    value: {
      ...header,
      nlmsg_len: BigInt(structures.nlmsghdr.size + payload.length),
    }
  });

  const result = new Uint8Array(headerAsBuffer.length + payload.length);
  result.set(headerAsBuffer, 0);
  result.set(payload, headerAsBuffer.length);
  return result;
};

/**
 * Whether the message terminates a request: NLMSG_ERROR (including acknowledgements) or NLMSG_DONE.
 */
const isTerminatingMessage = ({ message }: { message: TNetlinkMessage }) => {
  const { nlmsg_type } = message.header;
  return nlmsg_type === NLMSG_ERROR || nlmsg_type === NLMSG_DONE;
};

const readInt32 = ({ payload, structures }: { payload: Uint8Array, structures: TNetlinkStructures }) => {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return view.getInt32(0, structures.abi.endianness === "little");
};

/**
 * Extracts the errno of an NLMSG_ERROR or NLMSG_DONE message.
 * Returns `undefined` for an acknowledgement (error 0) and for other message types.
 */
const errnoOfMessage = ({ message, structures }: { message: TNetlinkMessage, structures: TNetlinkStructures }) => {
  if (!isTerminatingMessage({ message })) {
    return undefined;
  }

  const { header, payload } = message;

  // NLMSG_DONE carries an int, NLMSG_ERROR a struct nlmsgerr starting with an int
  if (payload.length < 4) {
    throw Error(`malformed netlink message: payload of type ${header.nlmsg_type} too short for an error code`);
  }

  const error = readInt32({ payload, structures });

  if (error === 0) {
    return undefined;
  }

  return -error;
};

export {
  nlmsgAlign,
  parseMessages,
  formatMessage,
  errnoOfMessage,
  isTerminatingMessage,
};

export type {
  TNetlinkHeader,
  TNetlinkMessage,
};
