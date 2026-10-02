# Post-trade review

A review is an immutable copy of records that already exist. It is not a
second explanation engine and it does not call the broker.

`recordPostTradeReview` reads one occurrence. Without a sealed decision it
returns `DECISION_UNAVAILABLE` and writes nothing. When the decision is
present it copies:

- the decision, risk, policy, gate, approval, execution, reconciliation,
  exit, and derived position state
- memory rows of kind `FACT` and `USER_FEEDBACK` under facts
- memory rows of kind `INTERPRETATION` under interpretations
- learning revisions the caller cites by id

It does not invent a probability, a sentence, or a deviation code. A cited
record that cannot be read fails closed. The same body at the same time is
idempotent. A later body is a new revision; the previous row stays.

Reconciliation records that review after the existing receipt is stored.
The desk snapshot shows it. Until a row exists, the room says the review is
not available.

Sealing a native tool turn writes the session's trading events and the
latest decision onto that occurrence. It does not run the broker. Risk,
policy, approval, the fire-time gate, and `submitAuthorizedExecution` stay
on the existing eligibility and execution boundary.
