import { expect, test } from '@playwright/test';

test('the placeholder page shows the server config', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByRole('heading', { name: 'RiverMind Poker' })).toBeVisible();
	await expect(page.getByTestId('config')).toHaveText('Opponents available: random');
});
