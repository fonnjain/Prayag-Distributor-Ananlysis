/** Prompt 115 F1/F2 verification inventory (kept executable and source-local). */
export const PROMPT114_QUESTIONS = [
  "Which state heads are ahead of plan and which are behind, and by how much?",
  "Is the business growing? Show the monthly shape, not just the YTD figure.",
  "Which members' order booking is not converting into dispatch?",
  "What is our projected year-end, seasonally adjusted?",
  "Which categories are growing and which are shrinking?",
  "Which products are we selling that we cannot price?",
  "Where is our margin concentrated, and where is it thin?",
  "Which SKUs are sold by only one or two retailers?",
  "Which retailers stopped buying this year?",
  "Which distributors have pending orders with no assigned member?",
  "Which customers buy narrowly compared with their peers?",
  "What figures are currently unreliable, and why?",
  "Where is our revenue concentrated?",
  "What data are we missing, and what is it worth?",
] as const;

export const PROMPT115_SAFE_FAILURES = [
  { question: "What is PTMT margin for April 2026?", path: "margin/PTMT/2026-27", expectation: "held; no value" },
  { question: "What is the projected year-end for a state head?", path: "gap/monthly-series", expectation: "seasonal-only or unavailable" },
  { question: "What are sales for a member in August?", path: "sales-deep-dive/{member}/2026-27", expectation: "booking vs dispatch distinguished" },
] as const;
