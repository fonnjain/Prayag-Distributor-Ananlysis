import india from "./prompt105-top80-metrics/india.js";
import canonical0 from "./prompt105-top80-canonical-metrics/andhra-pradesh.js";
import canonical1 from "./prompt105-top80-canonical-metrics/assam.js";
import canonical2 from "./prompt105-top80-canonical-metrics/bihar.js";
import canonical3 from "./prompt105-top80-canonical-metrics/chandigarh.js";
import canonical4 from "./prompt105-top80-canonical-metrics/chhattisgarh.js";
import canonical5 from "./prompt105-top80-canonical-metrics/delhi.js";
import canonical6 from "./prompt105-top80-canonical-metrics/goa.js";
import canonical7 from "./prompt105-top80-canonical-metrics/gujarat.js";
import canonical8 from "./prompt105-top80-canonical-metrics/haryana.js";
import canonical9 from "./prompt105-top80-canonical-metrics/himachal-pradesh.js";
import canonical10 from "./prompt105-top80-canonical-metrics/jammu-and-kashmir.js";
import canonical11 from "./prompt105-top80-canonical-metrics/jharkhand.js";
import canonical12 from "./prompt105-top80-canonical-metrics/karnataka.js";
import canonical13 from "./prompt105-top80-canonical-metrics/kerala.js";
import canonical14 from "./prompt105-top80-canonical-metrics/madhya-pradesh.js";
import canonical15 from "./prompt105-top80-canonical-metrics/maharashtra.js";
import canonical16 from "./prompt105-top80-canonical-metrics/odisha.js";
import canonical17 from "./prompt105-top80-canonical-metrics/punjab.js";
import canonical18 from "./prompt105-top80-canonical-metrics/rajasthan.js";
import canonical19 from "./prompt105-top80-canonical-metrics/tamil-nadu.js";
import canonical20 from "./prompt105-top80-canonical-metrics/telangana.js";
import canonical21 from "./prompt105-top80-canonical-metrics/uttar-pradesh.js";
import canonical22 from "./prompt105-top80-canonical-metrics/uttarakhand.js";
import canonical23 from "./prompt105-top80-canonical-metrics/west-bengal.js";

export const prompt105Top80IndiaMetrics = india;
export const prompt105Top80StateMetrics: Record<string, readonly { code: string; amount: number; qty: number; rank: number }[]> = {
  "Andhra Pradesh": canonical0,
  "Assam": canonical1,
  "Bihar": canonical2,
  "Chandigarh": canonical3,
  "Chhattisgarh": canonical4,
  "Delhi": canonical5,
  "Goa": canonical6,
  "Gujarat": canonical7,
  "Haryana": canonical8,
  "Himachal Pradesh": canonical9,
  "Jammu and Kashmir": canonical10,
  "Jharkhand": canonical11,
  "Karnataka": canonical12,
  "Kerala": canonical13,
  "Madhya Pradesh": canonical14,
  "Maharashtra": canonical15,
  "Odisha": canonical16,
  "Punjab": canonical17,
  "Rajasthan": canonical18,
  "Tamil Nadu": canonical19,
  "Telangana": canonical20,
  "Uttar Pradesh": canonical21,
  "Uttarakhand": canonical22,
  "West Bengal": canonical23
};
export const prompt105Top80StateUniverseSizes: Record<string, number> = {
  "Andhra Pradesh": 512,
  "Assam": 806,
  "Bihar": 1108,
  "Chandigarh": 19,
  "Chhattisgarh": 296,
  "Delhi": 294,
  "Goa": 49,
  "Gujarat": 427,
  "Haryana": 651,
  "Himachal Pradesh": 233,
  "Jammu and Kashmir": 595,
  "Jharkhand": 985,
  "Karnataka": 441,
  "Kerala": 483,
  "Madhya Pradesh": 1345,
  "Maharashtra": 1091,
  "Odisha": 871,
  "Punjab": 534,
  "Rajasthan": 598,
  "Tamil Nadu": 391,
  "Telangana": 455,
  "Uttar Pradesh": 1703,
  "Uttarakhand": 435,
  "West Bengal": 1496
};
