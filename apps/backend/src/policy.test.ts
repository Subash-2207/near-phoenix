import { test } from "node:test";
import assert from "node:assert/strict";
import { authorizeSpend, networkFromEnvironment } from "./policy.js";
test("network fails closed", () => { assert.equal(networkFromEnvironment(undefined), "localnet"); assert.throws(() => networkFromEnvironment("mainnet")); });
test("integer spending limits", () => { assert.equal(authorizeSpend("10", "10"), true); for (const value of ["11", "-1", "0", "1.5", "01", "1e3", (1n << 128n).toString()]) assert.equal(authorizeSpend(value, "10"), false); });
