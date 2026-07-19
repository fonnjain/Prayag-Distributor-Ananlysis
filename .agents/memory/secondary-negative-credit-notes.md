---
name: Secondary register negative credit notes
description: Known negative Sub-Total (netAmount) lines in the secondary register found by the extended no_negative_amounts validator.
---

Four credit-note rows with positive grossAmount but negative Sub Total (netAmount) were found:

| FY | Head | Month | netAmount |
|---|---|---|---|
| 2022-23 | Arijit Roychowdhury | Mar-23 | −66,167.40 |
| 2023-24 | Ashutosh Kumar | Feb-24 | −1,724 |
| 2023-24 | Ravinder Puri | Jan-24 | −21,845 |
| 2024-25 | Shyam Kumar Mishra | Sep-24 | −7,569 |

**Why:** The previous no_negative_amounts validator only checked grossAmount (Order Value) which is always positive for these rows. After extending the check to also include netAmount (Sub Total column), these lines are now correctly caught. They are genuine credit notes in the source sheets — rows where the distributor received a net credit (Sub Total < 0) but the original Order Value was positive.

**How to apply:** Before committing any of FY2022-23, FY2023-24, or FY2024-25 to the database, these lines must either be manually excluded from the dataset or confirmed as acceptable (e.g., represent verified returns that should be stored as negative netAmount). The `--commit` flag will be blocked by the validator until resolved.
