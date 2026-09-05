---
name: Secondary order-booking semantics
description: Evidence-backed naming rule for retailer/segment and retailer/item secondary register data.
---

`secondary_register_line` and `secondary_sku_line` are Segment Wise order-booking data at retailer/segment and retailer/item grain. Never describe them, or SKU Deep Dive retailer-level figures derived from them, as secondary sales, dispatch, sell-through, sell-out, or retailer offtake. Label their net measure as booked order net (Sub Total).

**Why:** Their configured workbook IDs and tabs match the order-booking sources used for `secondary_order_line`. Their schema contains order identifiers, order values, Sub Total, Order Total, and Cat. No., but no invoice, challan, dispatch-document, delivery-confirmation, or receipt field. No line-level secondary sale source exists in the system. The only sale-like secondary measure is `secondary_head_month.received_amount`, a person-per-month aggregate without retailer, item, quantity, or transaction-date detail.

**How to apply:** Use “secondary order booking” for these tables and all retailer/SKU surfaces, exports, alerts, diagnostics, comments, and documentation. Preserve “Sales Received” only for the separate State Head Dashboard aggregate, and preserve dispatch language for genuine primary `sale_line` data.