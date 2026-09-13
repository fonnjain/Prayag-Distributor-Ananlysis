/**
 * Shared Sales Deep Dive page/export field manifest.
 *
 * The value is deliberately metadata, not formatting code.  Both the page and
 * the workbook use this allowlist so an unknown source column cannot silently
 * become a business figure.
 */
export type SalesDeepDiveExtraUnit = "money" | "number" | "percent" | "text";

export type SalesDeepDiveExtraField = {
  label: string;
  unit: SalesDeepDiveExtraUnit;
  suppressed?: boolean;
};

export const SALES_DEEP_DIVE_EXTRA_MANIFEST: Record<string, SalesDeepDiveExtraField> = {
  STATE: { label: "State", unit: "text" },
  WORKINGSTATE: { label: "Working State", unit: "text" },
  DOJ: { label: "Date of Joining", unit: "text" },
  EMPCODE: { label: "Employee Code", unit: "text" },
  ACTIVELEFT: { label: "Active / Left", unit: "text" },
  OLDNEW: { label: "Old / New", unit: "text" },
  SECONDARYPRIMARY: { label: "Channel (Secondary / Primary)", unit: "text" },
  TARGETRANGE: { label: "Target Range", unit: "text" },
  JUN: { label: "Jun (month indicator)", unit: "number" },
  ACHIEVEMENT: { label: "Secondary Order Booking (achieved amount)", unit: "money" },
  TARGETACHIEVEMENT: { label: "Target Achievement", unit: "percent" },
  TARGETACHIEVEMENTSALE: { label: "Target Achievement (Sale)", unit: "percent" },
  DIRECTDEALERPRIMARYTARGETACHIEVEMENT: { label: "DD Primary Target Achievement", unit: "percent" },
  COSTRATIOSALE: { label: "Cost Ratio (Sale)", unit: "percent", suppressed: true },
  BELOW60DEALER: { label: "Dealers Below 60% Achievement", unit: "number" },
  BUSINESSACHIEVED50ANDABOVE: { label: "Parties — 50%+ Achievement", unit: "number" },
  TARGETCROSSCHECK: { label: "Target Cross-check", unit: "money" },
  BUSINESSACHIEVEDBY: { label: "Business Achieved By (parties)", unit: "number" },
  BUSINESSACHIVEDBYNOOFOLDPARTIES: { label: "Business — Old Parties", unit: "number" },
  BUSINESSACHIVEDBYNOOFNEWPARTIES: { label: "Business — New Parties", unit: "number" },
  BUSINESSACHIEVEDBYDIRECTDEALER: { label: "Business — Direct Dealer", unit: "number" },
  BUSINESSRECEIVEDPARTIESVISITS: { label: "Parties Giving Business", unit: "number" },
  NEWRETAILERS: { label: "New Retailers", unit: "number" },
  NEWPARTYORDERS: { label: "New Party Orders", unit: "number" },
  TOTALLEADCOUNTERS: { label: "Lead Counters", unit: "number" },
  TOTALLEADVISITS: { label: "Lead Visits", unit: "number" },
  TOTALNONLEADVISITS: { label: "Non-Lead Visits", unit: "number" },
  DISTRIBUTORCOUNTER: { label: "Distributor Counter", unit: "number" },
  DISTRIBUTORVISITS: { label: "Distributor Visits", unit: "number" },
  DIRECTDEALERCOUNTER: { label: "Direct Dealer Counter", unit: "number" },
  DIRECTDEALERVISITS: { label: "Direct Dealer Visits", unit: "number" },
  DISTRIBUTORDIRECTDEALERLEADCOUNTER: { label: "Distributor DD Lead Counter", unit: "number" },
  DISTRIBUTORDIRECTDEALERLEADVISITS: { label: "Distributor DD Lead Visits", unit: "number" },
  ACTIVEPARTIESVISITS: { label: "Active Parties Visited", unit: "number" },
  TOTALVISITS: { label: "Total Visits", unit: "number" },
  TOTALVISITSOFBUSINESSRECEIVEDPARTIES: { label: "Visits to Parties Giving Business", unit: "number" },
  TOTALVISITSOFVISITEDBUTNOBUSINESSRECEIVED: { label: "Visits to Parties with No Business", unit: "number" },
  VISITEDBUTNOBUSINESSRECEIVED: { label: "Visited — No Business", unit: "number" },
  NOVISITNOBUSINESSRECEIVED: { label: "No Visit, No Business", unit: "number" },
  AVERAGESALESPERDAY: { label: "Avg. Sales Per Day", unit: "money" },
  AVERAGEVISITPERDAY: { label: "Avg. Visits Per Day", unit: "number" },
  NOOFORDERS: { label: "No. of Orders", unit: "number" },
  TOTALWORKINGHOURS: { label: "Total Working Hours", unit: "number" },
  TOTALGPSKM: { label: "Total GPS km", unit: "number" },
  AVGDISTANCEKM: { label: "Avg. Distance (km)", unit: "number" },
  CTC: { label: "CTC", unit: "money" },
  CTC2025: { label: "CTC (FY 24-25)", unit: "money" },
  SALE2526: { label: "Sales FY 25-26", unit: "money" },
  TOTALORDER2526: { label: "Order Booking FY 25-26", unit: "money" },
  Q1: { label: "Q1 (Apr-Jun)", unit: "money" },
  Q2: { label: "Q2 (Jul-Sep)", unit: "money" },
  Q3: { label: "Q3 (Oct-Dec)", unit: "money" },
  Q4: { label: "Q4 (Jan-Mar)", unit: "money" },
  MONTHYDIRECTDEALERPRIMARYTARGET: { label: "Monthly DD Primary Target", unit: "money" },
  DIRECTDEALERPRIMARYTARGET: { label: "DD Primary Target", unit: "money" },
  SALE: { label: "Sale FY2025-26 (full year)", unit: "money" },
  TOTALORDER: { label: "Order Booking FY2025-26 (full year)", unit: "money" },
  SALENOWYTD: { label: "Sale YTD (current FY)", unit: "money" },
  TOTALORDERNOWYTD: { label: "Order Booking YTD (current FY)", unit: "money" },
};