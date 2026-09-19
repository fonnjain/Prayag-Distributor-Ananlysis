export type ProductWiseColumn =
  | "date" | "orderId" | "salesUserName" | "retailerName" | "retailerId"
  | "retailerMobile" | "distributorName" | "distributorCode" | "state"
  | "district" | "city" | "pincode" | "categoryName" | "productCode"
  | "gstType" | "gstPct" | "gstAmount" | "qty" | "discountPct"
  | "discountAmount" | "dealerOrderValueIncl" | "basicOrderValue" | "orderStatus";

export type ProductWiseColumnIndexes = Record<ProductWiseColumn, number | undefined>;

const ALIASES: Record<ProductWiseColumn, readonly string[]> = {
  date: ["Date"],
  orderId: ["Order ID"],
  salesUserName: ["Sales User Name"],
  retailerName: ["Customer Name", "Retailer Company Name"],
  retailerId: ["Dealer ID", "Retailer ID"],
  retailerMobile: ["Dealer Mobile", "Retailer Mobile"],
  distributorName: ["Channel Partner Name", "Distributor"],
  distributorCode: ["CP Code", "Distributor Code"],
  state: ["State"],
  district: ["District"],
  city: ["City"],
  pincode: ["Pincode"],
  categoryName: ["Category Name", "Segment"],
  productCode: ["Product Code"],
  gstType: ["GST Type"],
  gstPct: ["GST (%)"],
  gstAmount: ["GST Amount"],
  qty: ["Qty"],
  discountPct: ["Discount (%)"],
  discountAmount: ["Discount Amount"],
  dealerOrderValueIncl: ["Dealer Order Value", "Dealer Order Value (incl GST)", "Retailer Net Amount"],
  basicOrderValue: ["Basic Order Value", "Basic Order Value (ex-GST)", "Sub Total"],
  orderStatus: ["Order Status"],
};

const OPTIONAL = new Set<ProductWiseColumn>(["gstType"]);
const RECOGNIZED_OPTIONAL_HEADERS = new Set(["Employee ID", "Reporting Manager"]);

export function resolveProductWiseHeaders(headers: readonly string[]): ProductWiseColumnIndexes {
  const known = new Map<string, ProductWiseColumn>();
  for (const [column, aliases] of Object.entries(ALIASES) as [ProductWiseColumn, readonly string[]][]) {
    for (const alias of aliases) known.set(alias, column);
  }
  const indexes: ProductWiseColumnIndexes = {
    date: undefined, orderId: undefined, salesUserName: undefined, retailerName: undefined,
    retailerId: undefined, retailerMobile: undefined, distributorName: undefined,
    distributorCode: undefined, state: undefined, district: undefined, city: undefined,
    pincode: undefined, categoryName: undefined, productCode: undefined, gstType: undefined,
    gstPct: undefined, gstAmount: undefined, qty: undefined, discountPct: undefined,
    discountAmount: undefined, dealerOrderValueIncl: undefined, basicOrderValue: undefined,
    orderStatus: undefined,
  };
  const unknown: string[] = [];
  headers.forEach((header, index) => {
    const column = known.get(header);
    if (!column && RECOGNIZED_OPTIONAL_HEADERS.has(header)) return;
    if (!column) {
      unknown.push(header || `<blank column ${index + 1}>`);
      return;
    }
    if (indexes[column] !== undefined) {
      throw new Error(`Product-Wise header "${header}" duplicates canonical field "${column}".`);
    }
    indexes[column] = index;
  });
  if (unknown.length) throw new Error(`Product-Wise workbook has unknown headers: ${unknown.join(", ")}.`);
  const missing = (Object.keys(ALIASES) as ProductWiseColumn[])
    .filter((column) => indexes[column] === undefined && !OPTIONAL.has(column));
  if (missing.length) throw new Error(`Product-Wise workbook is missing required headers: ${missing.join(", ")}.`);
  return indexes;
}

export type ProductWiseSemanticValidation = {
  rowsChecked: number;
  rowsComparable: number;
  rowsWithinRs1: number;
  ratio: number;
  reverseRowsWithinRs1: number;
  reverseRatio: number;
};

export function validateProductWiseValues(
  rows: Array<{ basicOrderValue: number | null; dealerOrderValueIncl: number | null; gstAmount: number | null }>,
): ProductWiseSemanticValidation {
  let rowsComparable = 0;
  let rowsWithinRs1 = 0;
  let reverseRowsWithinRs1 = 0;
  for (const row of rows) {
    if (row.basicOrderValue == null || row.dealerOrderValueIncl == null || row.gstAmount == null) continue;
    rowsComparable++;
    if (Math.abs(row.dealerOrderValueIncl - (row.basicOrderValue + row.gstAmount)) <= 1) rowsWithinRs1++;
    if (Math.abs(row.basicOrderValue - (row.dealerOrderValueIncl + row.gstAmount)) <= 1) reverseRowsWithinRs1++;
  }
  const ratio = rows.length ? rowsWithinRs1 / rows.length : 0;
  const reverseRatio = rowsComparable ? reverseRowsWithinRs1 / rowsComparable : 0;
  if (rowsComparable !== rows.length || rows.length === 0 || ratio < 0.99) {
    if (reverseRatio >= 0.99) {
      throw new Error(`Product-Wise value columns appear swapped: inclusive ~= ex-GST + GST passed ${(reverseRatio * 100).toFixed(2)}% in reverse orientation.`);
    }
    throw new Error(`Product-Wise GST semantic check failed: ${rowsWithinRs1}/${rowsComparable} rows (${(ratio * 100).toFixed(2)}%) satisfy inclusive ~= ex-GST + GST within Rs 1; at least 99% required.`);
  }
  return { rowsChecked: rows.length, rowsComparable, rowsWithinRs1, ratio, reverseRowsWithinRs1, reverseRatio };
}