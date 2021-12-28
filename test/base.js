/* global describe */
/* global it */

import netlink from "../lib/index.js";

const NETLINK_ROUTE = 0;

describe("opening", function () {
  this.timeout(5000);

  describe("normal case", () => {
    it("should open without error", () => {
      netlink.open({
        family: NETLINK_ROUTE
      }).then((nl) => {
        return nl.close();
      });
    });
  });
});
