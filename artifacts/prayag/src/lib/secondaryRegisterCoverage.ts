export type SecondaryRegisterCoverage = {
  code: "H5";
  id: number | string;
  status: "open";
  owner: string;
  resolutionUrl: string;
  fiscalYear: string;
  targetMonths: string[];
  loadedMonths: string[];
  missingMonths: string[];
  missingRows: number;
  missingNet: number;
  message: string;
};