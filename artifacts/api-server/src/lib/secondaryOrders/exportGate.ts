/** Small, process-local gate for memory-heavy XLSX generation. */
export class ExportGate {
  private inUse = 0;

  constructor(private readonly limit: number) {}

  tryAcquire(): boolean {
    if (this.inUse >= this.limit) return false;
    this.inUse += 1;
    return true;
  }

  release(): void {
    // A defensive floor means a future early-return cannot create extra slots.
    this.inUse = Math.max(0, this.inUse - 1);
  }

  get active(): number {
    return this.inUse;
  }
}