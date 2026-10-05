import { createKernelAbiFor, hostAbi } from "po6";

type TErrorWithErrno = Error & {
  errno: number;
};

const { errnoCodes } = createKernelAbiFor({ machineAbi: hostAbi });

// aliases like EWOULDBLOCK follow their canonical name, so the first name of an errno wins
const errnoNames = Object.entries(errnoCodes).reduce((names, [name, errno]) => {
  return names.has(errno) ? names : new Map([...names, [errno, name]]);
}, new Map<number, string>());

const createErrorFromErrno = ({ operation, errno }: { operation: string, errno: number }): TErrorWithErrno => {
  const name = errnoNames.get(errno) ?? `unknown errno ${errno}`;

  // eslint-disable-next-line fp/no-mutating-assign
  return Object.assign(Error(`${operation} failed with ${name}`), { errno });
};

export {
  createErrorFromErrno,
};

export type {
  TErrorWithErrno,
};
