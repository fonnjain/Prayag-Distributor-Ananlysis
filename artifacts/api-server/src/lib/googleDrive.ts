// Google Drive access via the Replit "google-drive" connector integration.
// The connector proxy injects the OAuth token and handles refresh automatically.
// Do not cache the client — tokens expire.
import { ReplitConnectors } from "@replit/connectors-sdk";

export type DriveApiFile = {
  id: string;
  name: string;
  mimeType: string;
  iconLink?: string;
  webViewLink?: string;
  modifiedTime?: string;
  size?: string;
};

export type DriveFileListResult = {
  files: DriveApiFile[];
  nextPageToken?: string;
};

export async function listDriveFiles(opts: {
  q?: string;
  pageToken?: string;
}): Promise<DriveFileListResult> {
  const connectors = new ReplitConnectors();

  const clauses = ["trashed = false"];
  const search = opts.q?.trim();
  if (search) {
    const escaped = search.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    clauses.push(`name contains '${escaped}'`);
  }

  const params = new URLSearchParams();
  params.set("q", clauses.join(" and "));
  params.set("pageSize", "50");
  params.set("orderBy", "folder,modifiedTime desc");
  params.set("spaces", "drive");
  params.set(
    "fields",
    "nextPageToken, files(id, name, mimeType, iconLink, webViewLink, modifiedTime, size)",
  );
  params.set("supportsAllDrives", "true");
  params.set("includeItemsFromAllDrives", "true");
  if (opts.pageToken) {
    params.set("pageToken", opts.pageToken);
  }

  const response = await connectors.proxy(
    "google-drive",
    `/drive/v3/files?${params.toString()}`,
    { method: "GET" },
  );

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Google Drive API error ${response.status}: ${body}`);
  }

  const data = (await response.json()) as {
    files?: DriveApiFile[];
    nextPageToken?: string;
  };

  return {
    files: data.files ?? [],
    nextPageToken: data.nextPageToken,
  };
}
