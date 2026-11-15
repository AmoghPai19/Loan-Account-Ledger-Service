# Replay report

**Result: PASS**, 5000 events replayed in 3637 s (seed 20260101).

## Dataset
| | |
|---|---|
| Borrowers | 220 |
| Loans | 261 (WGL 130, EMI 68, FLT 63) |
| Events | 5000 (4700 unique payments + 300 duplicate deliveries) |
| Payment dates | 2026-01-11 to 2026-09-10 |

## How the events were handled
| | Count |
|---|---|
| First arrivals, in date order | 4433 |
| **Out-of-order arrivals** (a later-dated payment for the same loan arrived first) | **267**, all 267 posted at their real effective date |
| **Duplicate deliveries** (extra copies of an event id) | **300** |
| &nbsp;&nbsp; answered without posting again | 300 |
| &nbsp;&nbsp; event ids posted more than once | 0 |
| Events refused: loan already fully repaid (409) | 0 |
| Failed unexpectedly | 0 |
| **Repayments posted** (one per unique event id) | **4700** |

Duplicates are counted per event id: each id must post at most once, and every extra copy must be
answered without posting. 300 deliveries were answered from the stored result.

## Checks
| Check | Result |
|---|---|
| Trial balance: total debits = total credits | PASS (₹4,17,92,697.05 each side) |
| Every single transaction balances | PASS (0 unbalanced) |
| All account balances net to zero | PASS |
| No event posted more than once | PASS (0 posted twice) |
| Repayment transactions = events reported as posted | PASS (4700) |
| Money into the bank = sum of posted events | PASS (₹1,39,41,286.37) |
| No instalment overpaid, no interest recognised twice | PASS (0 instalments) |
| No negative receivable on any loan | PASS |

## Ledger at the end (2026-10-04)
| | |
|---|---|
| Disbursed | ₹2,56,60,000.00 |
| Repayments received | ₹1,39,41,286.37 |
| Principal still outstanding | ₹1,37,03,121.06 |
| Interest income | ₹21,50,859.29 (receivable ₹1,90,451.61) |
| Penalty income | ₹33,041.43 (receivable ₹12,796.66) |
| Borrower advances (owed back to borrowers) | ₹3,754.98 |
| Loans | 259 open, 2 closed |

## Accrual job
39 runs (weekly, plus a final run). Interest recognised: ₹6,20,501.82.
Penalty charged: ₹36,796.41; reversed after late-arriving payments: ₹3,754.98.
Failures: 0.
