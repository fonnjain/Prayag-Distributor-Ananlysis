# Secondary order-booking analytics approval

The stable-ID Product-Wise Secondary Order feed is **ORDER BOOKING**. It is
not dispatch and it is not the existing secondary-sales register. Passing an
upload-quality check never changes that basis.

## Approval criterion

The feed may be presented to the approvers for a possible, separately
implemented consumer only when all of these conditions hold:

1. There are **at least three clean uploads from distinct source files**.
   Distinctness is checked by the source SHA-256; re-uploading the same
   workbook does not create independent evidence.
2. Those three uploads are the latest consecutive clean evidence after the
   most recent `MATERIAL_REGRESSION`. A material regression restarts the clean
   evidence streak.
3. The first and last upload in that clean streak are at least **14 elapsed
   days** apart.
4. Each upload has no material quality reason: the stable-ID resolution floors,
   duplicate/collision limits, rejected-row limit, and comparison deltas all
   pass.

The admin endpoint reports this as
`analyticsApproval.status = READY_FOR_MANUAL_APPROVAL`. It must not be
interpreted as approval or used as a feature flag. Until a human decision is
recorded outside this loader, the feed remains
`ISOLATED_PENDING_RELIABILITY`.

## Who approves

Approval requires both:

- the **Sales Operations owner**, who confirms that the source report and its
  order-booking meaning are fit for the proposed business use; and
- the **Data/Engineering owner**, who confirms source lineage, identity
  coverage, duplicate/collision handling, and reconciliation.

The two approvers must agree on the exact consumer and must explicitly label
its metric basis as **ORDER BOOKING**. No approval can authorize silently
mixing these values with dispatch, `secondary_register_line`,
`secondary_sku_line`, or `sale_line`.

## Current scope

No sales, SKU, margin, or alert route is repointed by this criterion. A future
consumer must add its own explicit gate and basis label after the two-owner
approval is recorded.