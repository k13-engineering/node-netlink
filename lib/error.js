const knownErrors = {
  EPERM: {
    code: 1,
    message: "Operation not permitted",
  },
  ENOENT: {
    code: 2,
    message: "No such file or directory",
  },
  EAGAIN: {
    code: 11,
    message: "Resource temporarily unavailable",
  },
  EEXIST: {
    code: 17,
    message: "File already exists",
  },
  ENODEV: {
    code: 19,
    message: "No such device",
  },
  EINVAL: {
    code: 22,
    message: "Invalid argument",
  },
  ENOTSUP: {
    code: 48,
    message: "Operation not supported",
  },
};

const createFromErrorCode = ({ errorCode, message }) => {
  const knownErrorKey = Object.keys(knownErrors).find((key) => {
    return knownErrors[key].code === errorCode;
  });

  if (knownErrorKey) {
    const knownError = knownErrors[knownErrorKey];
    const errorObject = new Error(`${message ? `${message}: ` : ""}${knownError.message}`);
    errorObject.code = knownError.code;
    errorObject.errno = errorCode;
    return errorObject;
  } else {
    return new Error(`${message ? `${message}: ` : ""}unknown error code ${errorCode}`);
  }
};

export default {
  createFromErrorCode,
};
