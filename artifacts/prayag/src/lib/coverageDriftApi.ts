export async function fetchCoverageDrift<T>(
  path: string,
  request: typeof fetch = fetch,
): Promise<T> {
  const response = await request(path);
  // Drift is a review state, not a transport failure. Both coverage endpoints
  // return their complete reviewer payload with 409 when exceptions exist.
  if (!response.ok && response.status !== 409) {
    throw new Error(`Could not fetch coverage drift (${response.status})`);
  }
  return response.json() as Promise<T>;
}