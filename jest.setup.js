// Stop the billing job after all tests complete
afterAll(async () => {
  try {
    const { stopBillingJob } = await import('./src/jobs/billing.js');
    stopBillingJob();
  } catch (error) {
    // Billing job may not have been initialized in test mode
    console.debug('[Jest] Could not stop billing job:', error.message);
  }
});
