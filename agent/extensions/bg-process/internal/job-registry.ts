// job-registry: ordered map with settled-capacity pruning for long-lived jobs.
//
// Shared bookkeeping shape used by background jobs and async workers. Domain
// objects (BgJob, Worker) stay outside; this only owns id order and caps.

export class JobRegistry<T> {
  private readonly items = new Map<string, T>();
  private readonly order: string[] = [];

  get size(): number {
    return this.items.size;
  }

  has(id: string): boolean {
    return this.items.has(id);
  }

  get(id: string): T | undefined {
    return this.items.get(id);
  }

  /** Insert or replace. New ids append to order; replacements keep position. */
  set(id: string, item: T): void {
    if (!this.items.has(id)) this.order.push(id);
    this.items.set(id, item);
  }

  delete(id: string): boolean {
    if (!this.items.delete(id)) return false;
    const idx = this.order.indexOf(id);
    if (idx >= 0) this.order.splice(idx, 1);
    return true;
  }

  ids(): readonly string[] {
    return this.order;
  }

  values(): IterableIterator<T> {
    return this.items.values();
  }

  /** Oldest-first list of entries. */
  entries(): Array<{ id: string; item: T }> {
    const out: Array<{ id: string; item: T }> = [];
    for (const id of this.order) {
      const item = this.items.get(id);
      if (item !== undefined) out.push({ id, item });
    }
    return out;
  }

  /**
   * Drop oldest settled items until settled count <= maxSettled.
   * `isSettled` decides membership; live items are never pruned.
   */
  pruneSettled(isSettled: (item: T) => boolean, maxSettled: number): void {
    if (maxSettled < 0) return;
    const settled = this.entries().filter(({ item }) => isSettled(item));
    if (settled.length <= maxSettled) return;
    const excess = settled.length - maxSettled;
    for (let i = 0; i < excess; i++) {
      this.delete(settled[i].id);
    }
  }

  clear(): void {
    this.items.clear();
    this.order.length = 0;
  }
}
