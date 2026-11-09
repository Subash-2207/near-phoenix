const unsettled = new Set(["Reserved", "Pending", "Uncertain"]);

/** Only a fresh RPC observation may animate an operation to final success. */
export function finalizedPaymentTransition(
  previous,
  current,
  sourceIsFresh,
  isSandbox,
) {
  const kind = current?.kind ?? current?.operationKind;
  const status = current?.state ?? current?.status;
  return (
    sourceIsFresh &&
    !isSandbox &&
    kind !== "Refund" &&
    status === "Succeeded" &&
    unsettled.has(previous ?? "")
  );
}

export function backupActivationTransition(
  previous,
  current,
  sourceIsFresh,
  isSandbox,
) {
  return sourceIsFresh && !isSandbox && previous !== true && current === true;
}

export function checkpointCommitmentTransition(
  previousDigest,
  currentDigest,
  sourceIsFresh,
  isSandbox,
) {
  return (
    sourceIsFresh &&
    !isSandbox &&
    Boolean(currentDigest) &&
    previousDigest !== currentDigest
  );
}

export function verifiedReceiptTransition(
  previousKey,
  currentKey,
  sourceIsFresh,
  isSandbox,
) {
  return (
    sourceIsFresh &&
    !isSandbox &&
    Boolean(currentKey) &&
    previousKey !== currentKey
  );
}
