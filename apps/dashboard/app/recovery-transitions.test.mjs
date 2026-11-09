import assert from "node:assert/strict";
import {
  backupActivationTransition,
  checkpointCommitmentTransition,
  finalizedPaymentTransition,
  verifiedReceiptTransition,
} from "./recovery-transitions.mjs";

for (const prior of ["Reserved", "Pending", "Uncertain"]) {
  assert.equal(
    finalizedPaymentTransition(
      prior,
      { kind: "Payment", state: "Succeeded" },
      true,
      false,
    ),
    true,
  );
}
for (const prior of [undefined, "Succeeded", "Failed"]) {
  assert.equal(
    finalizedPaymentTransition(
      prior,
      { kind: "Payment", state: "Succeeded" },
      true,
      false,
    ),
    false,
  );
}
assert.equal(
  finalizedPaymentTransition(
    "Pending",
    { kind: "Refund", state: "Succeeded" },
    true,
    false,
  ),
  false,
);
assert.equal(
  finalizedPaymentTransition(
    "Pending",
    { kind: "Payment", state: "Succeeded" },
    false,
    false,
  ),
  false,
);
assert.equal(
  finalizedPaymentTransition(
    "Pending",
    { kind: "Payment", state: "Succeeded" },
    true,
    true,
  ),
  false,
);

assert.equal(backupActivationTransition(false, true, true, false), true);
assert.equal(backupActivationTransition(true, true, true, false), false);
assert.equal(backupActivationTransition(false, true, false, false), false);
assert.equal(backupActivationTransition(false, true, true, true), false);

assert.equal(checkpointCommitmentTransition("old", "new", true, false), true);
assert.equal(checkpointCommitmentTransition("", "new", true, false), true);
assert.equal(
  checkpointCommitmentTransition("same", "same", true, false),
  false,
);
assert.equal(checkpointCommitmentTransition("old", "new", false, false), false);

assert.equal(
  verifiedReceiptTransition("", "epoch:signature", true, false),
  true,
);
assert.equal(
  verifiedReceiptTransition("epoch:signature", "epoch:signature", true, false),
  false,
);
assert.equal(
  verifiedReceiptTransition("", "epoch:signature", false, false),
  false,
);
assert.equal(
  verifiedReceiptTransition("", "epoch:signature", true, true),
  false,
);
console.log("Recovery transition tests passed");
