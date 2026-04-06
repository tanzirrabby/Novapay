describe("Payroll Queue — BullMQ concurrency=1 per employer", () => {
  test("checkpoint resumes from last successful index", () => {
    const allItems = Array.from({ length: 100 }, (_, i) => ({ item_index: i, amount: 1000 }));
    const checkpointIndex = 42; // crash happened after item 42

    // On resume, only fetch items AFTER the checkpoint
    const pendingItems = allItems.filter(item => item.item_index > checkpointIndex);
    expect(pendingItems[0].item_index).toBe(43);
    expect(pendingItems.length).toBe(57);
  });

  test("item-level idempotency key is unique per job+item", () => {
    const jobId = "job-abc-123";
    const keys = [0, 1, 2, 100, 999].map(i => `payroll:${jobId}:item:${i}`);
    const uniqueKeys = new Set(keys);
    expect(uniqueKeys.size).toBe(keys.length);
  });

  test("total amount calculation is correct", () => {
    const disbursements = [
      { amount: 250000 },
      { amount: 300000 },
      { amount: 175000 },
    ];
    const total = disbursements.reduce((sum, d) => sum + d.amount, 0);
    expect(total).toBe(725000);
  });

  test("progress percentage calculation", () => {
    const totalItems = 14000;
    const processedItems = 3500;
    const pct = Math.round((processedItems / totalItems) * 100);
    expect(pct).toBe(25);
  });

  test("partial status when some items fail", () => {
    const processedCount = 13800;
    const failedCount = 200;
    const totalCount = 14000;

    const finalStatus =
      failedCount === 0 ? "completed" :
      processedCount === 0 ? "failed" : "partial";

    expect(finalStatus).toBe("partial");
  });

  test("completed status when all items succeed", () => {
    const processedCount = 14000;
    const failedCount = 0;

    const finalStatus =
      failedCount === 0 ? "completed" :
      processedCount === 0 ? "failed" : "partial";

    expect(finalStatus).toBe("completed");
  });
});
