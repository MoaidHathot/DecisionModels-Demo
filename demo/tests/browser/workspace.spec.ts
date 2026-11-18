import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function startComparison(page: Page) {
  const responsePromise = page.waitForResponse((response) => response.url().endsWith('/api/runs') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Run comparison' }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(202);
  const run = await response.json() as { id: string };
  await expect(page.locator('.results-section')).toHaveAttribute('data-run-id', run.id);
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Models', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run comparison' })).toBeEnabled();
  (page as typeof page & { scriptErrors: string[] }).scriptErrors = errors;
});

test.afterEach(async ({ page }) => {
  expect((page as typeof page & { scriptErrors: string[] }).scriptErrors).toEqual([]);
});

test('sample selection, warm-up, live table, output inspection, charts and JSON export', async ({ page }, testInfo) => {
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('dark');
  await expect(page.getByRole('heading', { name: /Same question/ })).toHaveCount(0);
  expect((await page.locator('.results-toolbar').boundingBox())!.y).toBeLessThan(450);
  await expect(page.getByLabel('Execution mode', { exact: true })).toHaveValue('race');
  await expect(page.getByRole('textbox', { name: 'Custom request JSON' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Preview Refund triage' }).click();
  await expect(page.getByRole('dialog')).toContainText('"severity"');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Preview Refund triage' })).toBeFocused();
  await page.getByRole('button', { name: /Warm up/ }).click();
  await expect(page.getByText('Warm-up complete', { exact: true })).toBeVisible();
  await expect(page.getByTestId('result-row')).toHaveCount(0);
  await startComparison(page);
  await expect(page.getByTestId('result-row')).toHaveCount(6);
  await expect(page.locator('.status-queued').first()).toBeVisible();
  await expect(page.locator('.run-badge')).toHaveText('Complete');
  await expect(page.getByTestId('result-row').filter({ hasText: 'fixture-decision-1' })).toHaveCount(2);
  await expect(page.getByTestId('result-row').filter({ hasText: 'fixture-multilingual' })).toHaveCount(2);
  await expect(page.getByTestId('result-row').filter({ hasText: 'fixture-llm' })).toHaveCount(2);
  expect(await page.getByTestId('finish-order').allTextContents()).toEqual(['#1', '#2', '#3', '#1', '#2', '#3']);
  await expect(page.getByTestId('result-row').first()).toContainText('LocalLaya · sidecar');
  await expect(page.locator('.probability-line').filter({ hasText: 'Est. P(yes)' })).toHaveCount(1);
  await expect(page.locator('.probability-line').filter({ hasText: 'P(choice)' }).first()).toContainText('96.0%');
  await expect(page.locator('.probability-line').filter({ hasText: 'P(yes)' }).first()).toContainText('12.0%');
  expect(await page.getByTestId('result-row').evaluateAll((rows) => rows.every((row) => {
    const decisions = [...row.querySelectorAll('.decision-line')];
    const probabilities = [...row.querySelectorAll('.probability-line')];
    return decisions.every((decision, index) => Math.abs(decision.getBoundingClientRect().top - probabilities[index]!.getBoundingClientRect().top) < 1);
  }))).toBe(true);
  await page.getByRole('button', { name: /View details for GitHub Copilot, Refund triage/ }).click();
  await page.getByRole('button', { name: 'Raw output', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('fixture {not JSON}');
  await expect(page.getByRole('dialog')).toContainText('Exit code: 0');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: /View details for GitHub Copilot, Refund triage/ })).toBeFocused();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Export JSON' }).click();
  const download = await downloadPromise;
  const exported = JSON.parse(await readFile((await download.path())!, 'utf8'));
  expect(exported.run.tasks).toHaveLength(6);
  expect(exported.results).toHaveLength(6);
  expect(exported.run.execution).toBe('race');
  expect(exported.results.filter((result: { task: { result: { probabilitySource: string } } }) => result.task.result.probabilitySource === 'llm-estimate')).toHaveLength(2);
  expect(exported.results.every((result: { output: { stdout: string } }) => result.output.stdout.includes('answers'))).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('desktop-table.png'), fullPage: true });
  await page.getByRole('tab', { name: 'Insights' }).click();
  await expect(page.getByRole('heading', { name: 'Median latency' })).toBeVisible();
  await expect(page.getByRole('table').getByRole('row')).toHaveCount(3);
  await page.getByRole('button', { name: 'Tool-reported', exact: true }).click();
  await expect(page.getByText('Median tool-reported time per invocation')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('desktop-insights.png'), fullPage: true });
});

test('pasted JSON validation, repeated parallel calls, and refresh during a live run', async ({ page }) => {
  await page.getByRole('button', { name: 'Paste JSON', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Custom request JSON' });
  await editor.fill('{ invalid');
  await expect(page.getByRole('button', { name: 'Run comparison' })).toBeDisabled();
  await expect(page.locator('.editor-status')).toHaveClass(/invalid/);
  const request = { state: 'مرحبا — $(throw "must stay data")', questions: { refund: { type: 'predicate', instructions: 'A refund?' }, team: { type: 'choice', instructions: 'Which team?', choices: { billing: 'Billing', support: 'Support' } } } };
  await editor.fill(JSON.stringify(request));
  await page.getByLabel('Repetitions', { exact: true }).selectOption('2');
  await page.getByLabel('Execution mode', { exact: true }).selectOption('race');
  await startComparison(page);
  await expect(page.getByTestId('result-row')).toHaveCount(6);
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Custom request JSON' })).toHaveValue(/must stay data/);
  await expect(page.locator('.run-badge')).toHaveText('Complete');
  await expect(page.getByTestId('result-row')).toHaveCount(6);
  await expect(page.getByTestId('result-row').first()).toContainText('Pasted request');
  await page.getByRole('searchbox', { name: 'Filter results' }).fill('fixture-multilingual');
  await expect(page.getByTestId('result-row')).toHaveCount(2);
  await page.getByRole('searchbox', { name: 'Filter results' }).fill('');
  await page.getByRole('button', { name: /View details for/ }).first().click();
  await page.getByRole('button', { name: 'Input', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('must stay data');
});

test('failures remain inspectable and stopping a batch cancels running and queued calls', async ({ page }) => {
  const entries = page.getByRole('region', { name: 'Models', exact: true });
  await entries.getByRole('checkbox', { name: 'Select GitHub Copilot', exact: true }).uncheck();
  await entries.getByRole('checkbox', { name: 'Select LocalLaya · sidecar', exact: true }).uncheck();
  await entries.getByRole('checkbox', { name: 'Select Copilot LLM', exact: true }).uncheck();
  await entries.getByRole('checkbox', { name: 'Select Broken fixture', exact: true }).check();
  await startComparison(page);
  await expect(page.locator('.run-badge')).toHaveText('Finished · 2 failed');
  await page.getByRole('button', { name: /View details for/ }).first().click();
  await expect(page.getByRole('dialog')).toContainText('Simulated CLI failure after output');
  await expect(page.getByRole('dialog')).toContainText('code 7');
  await page.keyboard.press('Escape');
  await entries.getByRole('checkbox', { name: 'Select Broken fixture', exact: true }).uncheck();
  await entries.getByRole('checkbox', { name: 'Select Slow fixture', exact: true }).check();
  await page.getByLabel('Repetitions', { exact: true }).selectOption('3');
  await startComparison(page);
  await expect(page.getByTestId('result-row')).toHaveCount(6);
  await page.getByRole('button', { name: 'Stop run', exact: true }).click();
  await expect(page.locator('.run-badge')).toHaveText('Stopped');
  await expect(page.locator('.task-status.status-cancelled')).toHaveCount(6);
  await expect(page.getByRole('button', { name: 'Run comparison' })).toBeEnabled();
});

test('desktop, chart, and configuration dialog meet automated accessibility checks', async ({ page }, testInfo) => {
  // Produce a completed comparison independently of the previous test's stopped run.
  await startComparison(page);
  await expect(page.locator('.run-badge')).toHaveText('Complete');
  const inspect = async () => {
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    await testInfo.attach('accessibility', { body: JSON.stringify(result.violations, null, 2), contentType: 'application/json' });
    expect(result.violations).toEqual([]);
  };
  await inspect();
  await page.getByRole('tab', { name: 'Insights' }).click();
  await inspect();
  await page.getByRole('button', { name: 'Configure workspace' }).click();
  await expect(page.getByRole('dialog')).toContainText('{input}');
  await expect(page.getByRole('dialog')).toContainText('systemPrompt');
  await expect(page.getByRole('dialog')).toContainText('reasoningEffort');
  await inspect();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Configure workspace' })).toBeFocused();
});

test('mobile workspace fits the viewport and keeps the table horizontally scrollable', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Configure workspace' })).toBeVisible();
  await startComparison(page);
  await expect(page.locator('.run-badge')).toHaveText('Complete');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const scrollable = page.getByRole('region', { name: 'Scrollable comparison results' });
  expect(await scrollable.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('mobile-table.png'), fullPage: true });
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Paste JSON', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Custom request JSON' })).toBeVisible();
});

test('a late stop response recovers completed results after a stream interruption and allows another stop', async ({ page }) => {
  // Simulate losing the event stream and its GET fallback, then a stop request
  // reaching the server only after the commands have already completed.
  await page.route('**/api/runs/*/events', (route) => route.abort());
  await page.route(/\/api\/runs\/[^/]+$/, (route) => route.request().method() === 'GET' ? route.abort() : route.continue());
  await page.route('**/api/runs/*/cancel', async (route) => {
    const url = route.request().url().replace(/\/cancel$/, '/events');
    // APIRequestContext is independent of page routing; this stream closes when
    // the real server finishes the run, without mocking its state or results.
    const stream = await page.request.get(url);
    expect(stream.status()).toBe(200);
    await stream.text();
    await route.fulfill({ response: await route.fetch() });
  });
  await startComparison(page);
  await page.getByRole('button', { name: 'Stop run', exact: true }).click();
  await expect(page.locator('.run-badge')).toHaveText('Complete');
  await expect(page.locator('.task-status.status-success')).toHaveCount(6);
  await expect(page.locator('.connection-banner')).toHaveCount(0);
  await page.unrouteAll({ behavior: 'wait' });

  await page.getByRole('checkbox', { name: 'Select GitHub Copilot', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: 'Select LocalLaya · sidecar', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: 'Select Copilot LLM', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: 'Select Slow fixture', exact: true }).check();
  await startComparison(page);
  await expect(page.getByRole('button', { name: 'Stop run', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Stop run', exact: true }).click();
  await expect(page.locator('.run-badge')).toHaveText('Stopped');
});
