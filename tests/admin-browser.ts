import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { expect, type BrowserContext } from '@playwright/test';

export async function adminBrowserChecks(
  context: BrowserContext,
  base: string,
) {
  const page = await context.newPage();
  const errors: string[] = [],
    violations: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (
      /content security policy|violates.*directive|refused to (execute|load)/i.test(
        message.text(),
      )
    )
      violations.push(message.text());
  });
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.type());
    return dialog.accept();
  });
  await page.goto(base + '/admin/edit');
  const csrf = await page.locator('input[name=csrf]').first().inputValue();
  const api = async (action: string, fields: Record<string, string>) => {
    const response = await context.request.post(base + '/api/admin/' + action, {
      form: { csrf, ...fields },
      headers: { Origin: base, Accept: 'application/json' },
    });
    assert.equal(response.status(), 200, await response.text());
    return response.json();
  };
  const create = (fields: Record<string, string>) =>
    api('post', {
      title: 'Browser admin fixture',
      slug: 'browser-admin-' + randomUUID(),
      type: 'article',
      intent: 'save',
      ...fields,
    });
  const exactBody =
    '\nOpening paragraph & café\n\n    intentional code\n\n- list\n  - nested\n\n</textarea><script>window.editorCompromised=true</script>\n';
  const exactSummary = '\nSummary with leading and trailing newlines\n';
  const fixture = await create({ body: exactBody, summary: exactSummary });
  await page.goto(base + '/admin/edit?id=' + fixture.id);
  await expect(page.locator('#source-warning')).toBeVisible();
  await expect(page.locator('#body')).toHaveValue(exactBody);
  await expect(page.locator('textarea[name=summary]')).toHaveValue(
    exactSummary,
  );
  assert.equal(
    await page.evaluate(() => (window as any).editorCompromised),
    undefined,
  );
  for (let round = 0; round < 2; round++) {
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(page.locator('#save-status')).toHaveText(/^Saved at/);
    await page.reload();
    await expect(page.locator('#body')).toHaveValue(exactBody);
    await expect(page.locator('textarea[name=summary]')).toHaveValue(
      exactSummary,
    );
  }
  const exported = unzipSync(
    await (await context.request.get(base + '/api/admin/export')).body(),
  );
  const stored = JSON.parse(strFromU8(exported['content.json'])).posts.find(
    (post: any) => post.id === fixture.id,
  );
  assert.equal(
    stored.body,
    exactBody,
    'Saving must preserve LF bytes in the database, not only normalize them when redisplayed',
  );
  assert.equal(stored.summary, exactSummary);
  const crlf = await create({
    title: 'CRLF fixture',
    body: '\r\nA CRLF paragraph\r\n\r\n    code\r\n',
  });
  await page.goto(base + '/admin/edit?id=' + crlf.id);
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.locator('#save-status')).toHaveText(/^Saved at/);
  const crlfExport = unzipSync(
    await (await context.request.get(base + '/api/admin/export')).body(),
  );
  assert.equal(
    JSON.parse(strFromU8(crlfExport['content.json'])).posts.find(
      (post: any) => post.id === crlf.id,
    ).body,
    '\r\nA CRLF paragraph\r\n\r\n    code\r\n',
  );
  const key = randomUUID();
  const once = await create({
    slug: 'creation-replay',
    request_key: key,
    body: 'once',
  });
  const twice = await create({
    slug: 'creation-replay',
    request_key: key,
    body: 'once',
  });
  assert.equal(once.id, twice.id);
  assert.equal(twice.creation_replayed, true);

  const live = await create({
    title: 'Live workflow fixture',
    slug: 'browser-live-workflow',
    body: 'Original live paragraph',
  });
  await api('post-action', {
    id: String(live.id),
    version: String(live.version),
    intent: 'publish',
  });
  await page.goto(base + '/admin/edit?id=' + live.id);
  await page.getByRole('button', { name: 'Markdown', exact: true }).click();
  await page.locator('#body').fill('Unpublished private paragraph');
  await expect(page.locator('#save-status')).toHaveText(/^Saved at/, {
    timeout: 10000,
  });
  await expect(page.locator('#post-status')).toHaveText(
    'Published · unpublished changes',
  );
  assert(
    (
      await (
        await context.request.get(base + '/posts/browser-live-workflow')
      ).text()
    ).includes('Original live paragraph'),
  );
  assert(
    !(
      await (
        await context.request.get(base + '/posts/browser-live-workflow')
      ).text()
    ).includes('Unpublished private paragraph'),
  );
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.locator('#preview')).toHaveText(
    'Unpublished private paragraph',
  );
  await page.getByRole('button', { name: 'Close preview' }).click();
  await page
    .getByRole('button', { name: 'Update live post', exact: true })
    .click();
  await expect(page.locator('#post-status')).toHaveText('Published');
  await expect
    .poll(async () =>
      (
        await (
          await context.request.get(base + '/posts/browser-live-workflow')
        ).text()
      ).includes('Unpublished private paragraph'),
    )
    .toBe(true);

  // Both tabs start from the same edit version. The second tab must retain its text.
  const other = await context.newPage();
  other.on('dialog', (dialog) => dialog.accept());
  await other.goto(base + '/admin/edit?id=' + live.id);
  await other.getByRole('button', { name: 'Markdown', exact: true }).click();
  await page.getByRole('button', { name: 'Markdown', exact: true }).click();
  await page.locator('#body').fill('First tab private change');
  await expect(page.locator('#save-status')).toHaveText(/^Saved at/, {
    timeout: 10000,
  });
  await other.locator('#body').fill('Second tab must survive');
  await expect(other.locator('#editor-error')).toContainText('another tab', {
    timeout: 10000,
  });
  await expect(other.locator('#body')).toHaveValue('Second tab must survive');
  await expect(other.locator('#download-draft')).toBeVisible();
  await other.close();
  await page.locator('[data-revision]').first().click();
  await expect(page.locator('#revision-comparison')).toBeVisible();
  await page.getByRole('button', { name: 'Restore as private draft' }).click();
  await expect(page.locator('#post-status')).toHaveText(
    'Published · unpublished changes',
  );
  assert(
    (
      await (
        await context.request.get(base + '/posts/browser-live-workflow')
      ).text()
    ).includes('Unpublished private paragraph'),
    'Restoring history must keep the live article available',
  );
  await page.getByRole('button', { name: 'Markdown', exact: true }).click();

  await page.route('**/api/admin/post', (route) => route.abort('failed'));
  await page.locator('#body').fill('Text survives a failed request');
  await expect(page.locator('#editor-error')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#body')).toHaveValue(
    'Text survives a failed request',
  );
  await page.unroute('**/api/admin/post');
  await page.locator('#body').press('ControlOrMeta+s');
  await expect(page.locator('#save-status')).toHaveText(/^Saved at/);
  await page.route('**/api/admin/post', (route) =>
    route.fulfill({ status: 401, body: 'Unauthorized' }),
  );
  await page.route('**/api/admin/session', (route) =>
    route.fulfill({ status: 401, body: 'Unauthorized' }),
  );
  await page.locator('#body').fill('Text survives an expired session');
  await expect(page.locator('#editor-error')).toContainText('session expired', {
    timeout: 10000,
  });
  await expect(
    page.getByRole('link', { name: 'Sign in in another tab' }),
  ).toBeVisible();
  await expect(page.locator('#body')).toHaveValue(
    'Text survives an expired session',
  );
  await page.unroute('**/api/admin/post');
  await page.unroute('**/api/admin/session');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.locator('#save-status')).toHaveText(/^Saved at/);
  await page.getByRole('button', { name: 'Unpublish', exact: true }).click();
  await expect(page.locator('#post-status')).toHaveText('Draft');
  assert.equal(
    (await context.request.get(base + '/posts/browser-live-workflow')).status(),
    404,
  );
  await expect(page.locator('#body')).toHaveValue(
    'Text survives an expired session',
  );
  await page
    .getByRole('button', { name: 'Move to trash', exact: true })
    .click();
  await expect(page.locator('#post-status')).toHaveText('Trash');
  await page
    .getByRole('button', { name: 'Restore to drafts', exact: true })
    .click();
  await expect(page.locator('#post-status')).toHaveText('Draft');
  await expect(page.locator('#body')).toHaveValue(
    'Text survives an expired session',
  );

  // Visual commands and Markdown conversion run under the production CSP.
  const visual = await create({
    title: 'A calmer writing workspace',
    slug: 'browser-visual-fixture',
    summary:
      'A private draft with reliable saving and clear publication controls.',
    body: 'A paragraph with **bold**, _italic_, and a [link](https://example.com).\n\n## A useful heading\n\n- One idea\n- Another idea\n\n```ts\nconst answer = 42;\n```',
  });
  await page.goto(base + '/admin/edit?id=' + visual.id);
  await expect(page.locator('#visual-editor')).toBeVisible();
  await expect(page.locator('.tiptap h2')).toHaveText('A useful heading');
  await page.locator('.tiptap a').click();
  await page.getByRole('button', { name: 'Link', exact: true }).click();
  await expect(page.locator('#link-text')).toHaveValue('link');
  await page.locator('#link-text').fill('revised link');
  await page.locator('#link-url').fill('https://example.com/revised');
  await page.getByRole('button', { name: 'Insert link', exact: true }).click();
  await expect(page.locator('.tiptap a')).toHaveText('revised link');
  await page.locator('.tiptap').click();
  await page.locator('.tiptap').press('ControlOrMeta+End');
  await page.locator('.tiptap').press('ArrowDown');
  await page.getByRole('button', { name: 'Table', exact: true }).click();
  await expect(page.locator('.tiptap table')).toBeVisible();
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.locator('#save-status')).toHaveText(/^Saved at/);
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.locator('#preview table')).toBeVisible();
  await expect(page.locator('#preview strong')).toHaveText('bold');
  await page.getByRole('button', { name: 'Close preview' }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Markdown', exact: true }).click();
  await expect(page.locator('#body')).toHaveValue(/const answer = 42;/);

  const repairText = 'Paragraph\n\n    intentional code\n\n- list\n  - nested';
  const legacy = ' '.repeat(18) + repairText + '\n' + ' '.repeat(16);
  const damaged = await create({ title: 'Legacy indentation', body: legacy });
  await page.goto(base + '/admin/edit?id=' + damaged.id);
  await page
    .getByText('Fix old accidental indentation', { exact: true })
    .click();
  await page.getByRole('button', { name: 'Preview correction' }).click();
  await expect(page.locator('#body')).toHaveValue(legacy);
  await page.getByRole('button', { name: 'Apply correction' }).click();
  await expect(page.locator('#body')).toHaveValue(repairText);
  await page.getByRole('button', { name: 'Undo correction' }).click();
  await expect(page.locator('#body')).toHaveValue(legacy);
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.locator('#save-status')).toHaveText(/^Saved at/);

  await page.goto(base + '/admin?q=Live+workflow+fixture&status=draft');
  const row = page
    .getByRole('row')
    .filter({ hasText: 'Live workflow fixture' });
  await row.getByRole('button', { name: 'Pin', exact: true }).click();
  await expect(row).toContainText('Pinned');
  await row.getByRole('checkbox').check();
  await page.locator('#bulk-intent').selectOption('unpin');
  await page.getByRole('button', { name: 'Apply to selected' }).click();
  await expect(
    row.getByRole('button', { name: 'Pin', exact: true }),
  ).toBeVisible();
  await row.getByRole('link', { name: 'Edit', exact: true }).click();
  await page.getByRole('link', { name: 'Back to posts' }).click();
  await expect(page).toHaveURL(/q=Live\+workflow\+fixture&status=draft/);

  // The settings textarea has the same exact leading-newline requirement.
  await page.goto(base + '/admin/settings');
  await page
    .locator('textarea[name=bio]')
    .fill('\nA biography with intentional newlines\n');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.locator('[data-form-result]')).toHaveText(
    'Settings saved.',
  );
  await page.reload();
  await expect(page.locator('textarea[name=bio]')).toHaveValue(
    '\nA biography with intentional newlines\n',
  );
  await page.getByRole('button', { name: '+ Add link' }).click();
  const newLink = page.locator('.profile-link-row').last();
  await newLink.locator('input[name=link_label]').fill('A useful link');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(newLink.locator('input[name=link_url]')).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await expect(newLink.locator('input[name=link_label]')).toHaveValue(
    'A useful link',
  );
  await newLink
    .locator('input[name=link_url]')
    .fill('https://example.com/quality');
  await page.getByRole('button', { name: 'Browse uploaded images' }).click();
  await page.locator('.media-thumbnail').first().click();
  await expect(page.locator('[data-image-preview=photo]')).toBeVisible();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.locator('[data-form-result]')).toHaveText(
    'Settings saved.',
  );
  await page.reload();
  await expect(
    page.locator('input[name=link_label]').filter({ visible: true }),
  ).toHaveCount(3);
  await expect(page.locator('input[name=link_label]').nth(1)).toHaveValue(
    'A useful link',
  );

  await page.goto(base + '/admin/projects');
  await expect(page.locator('[data-project-editor]')).toHaveCount(0);
  await page
    .getByRole('link', { name: 'Add project', exact: true })
    .first()
    .click();
  const projectForm = page.locator('[data-project-editor]');
  await projectForm.locator('input[name=name]').fill('Browser quality project');
  await projectForm
    .locator('textarea[name=description]')
    .fill('\nA multiline project description\n');
  await projectForm
    .locator('input[name=url]')
    .fill('https://example.com/project');
  await expect(page.locator('[data-project-preview-name]')).toHaveText(
    'Browser quality project',
  );
  await expect(page.locator('[data-project-save-status]')).toHaveText(
    'Unsaved changes',
  );
  await page.getByRole('button', { name: 'Browse uploaded images' }).click();
  await page.locator('.media-thumbnail').first().click();
  await expect(page.locator('[data-image-preview=image]')).toBeVisible();
  const cover = await projectForm.locator('input[name=image]').inputValue();
  // A failed save must keep text, cover and dirty state available for retry.
  await page.route('**/api/admin/project', (route) => route.abort());
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await expect(page.locator('[data-project-save-status]')).toHaveText(
    'Save failed. Your changes are still here.',
  );
  await expect(projectForm.locator('input[name=name]')).toHaveValue(
    'Browser quality project',
  );
  await page.unroute('**/api/admin/project');
  const dialogsBeforeSave = dialogs.length;
  await projectForm.locator('input[name=name]').press('ControlOrMeta+s');
  await expect(page).toHaveURL(/saved=1/);
  assert.equal(
    dialogs.length,
    dialogsBeforeSave,
    'Successful saves must not show an unsaved warning',
  );
  const project = page
    .locator('.admin-project-card')
    .filter({ hasText: 'Browser quality project' });
  await expect(project).toBeVisible();
  await expect(project.locator('.project-thumbnail img')).toHaveAttribute(
    'src',
    cover,
  );
  for (const status of ['paused', 'completed'])
    await api('project', {
      name: 'Quality ' + status,
      description: 'Filter fixture',
      status,
      image: '',
      url: '',
      source_url: '',
    });
  await page.reload();
  await page.locator('input[name=q]').fill('quality');
  await page.locator('select[name=status]').selectOption('active');
  await page.locator('select[name=sort]').selectOption('name');
  await page
    .getByRole('button', { name: 'Apply filters', exact: true })
    .click();
  await expect(page.locator('.admin-project-card')).toHaveCount(1);
  await project.getByRole('link', { name: 'Edit', exact: true }).click();
  await expect(page.locator('textarea[name=description]')).toHaveValue(
    '\nA multiline project description\n',
  );
  await expect(page.locator('[data-project-save-status]')).toHaveText(
    'No unsaved changes',
  );
  await page.locator('select[name=status]').selectOption('paused');
  await expect(page.locator('[data-project-preview-status]')).toHaveAttribute(
    'data-status',
    'paused',
  );
  await page.getByRole('button', { name: 'Remove cover / photo' }).click();
  await expect(page.locator('[data-image-preview=image]')).toBeHidden();
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await expect(page).toHaveURL(/q=quality&status=active&sort=name&saved=1/);
  await expect(
    page.getByRole('heading', { name: 'No projects match your filters.' }),
  ).toBeVisible();
  await page
    .getByRole('link', { name: 'Clear filters', exact: true })
    .first()
    .click();
  await project.getByRole('link', { name: 'Edit', exact: true }).click();
  await expect(page.locator('select[name=status]')).toHaveValue('paused');
  await expect(projectForm.locator('input[name=image]')).toHaveValue('');
  await page.locator('select[name=status]').selectOption('active');
  await page.getByRole('button', { name: 'Browse uploaded images' }).click();
  await page.locator('.media-thumbnail').first().click();
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await project.getByRole('link', { name: 'Edit', exact: true }).click();
  // Cancel warns only when the form has changed.
  await projectForm.locator('input[name=name]').fill('Unsaved project name');
  const warningsBeforeCancel = dialogs.filter(
    (kind) => kind === 'beforeunload',
  ).length;
  await page.getByRole('link', { name: 'Cancel', exact: true }).click();
  await expect(page).toHaveURL(base + '/admin/projects');
  assert.equal(
    dialogs.filter((kind) => kind === 'beforeunload').length,
    warningsBeforeCancel + 1,
  );
  await expect(project).toBeVisible();
  await page.locator('input[name=q]').fill('nothing-matches-this-project');
  await page
    .getByRole('button', { name: 'Apply filters', exact: true })
    .click();
  await expect(page.locator('.admin-project-card')).toHaveCount(0);
  await page.goto(base + '/admin/projects?id=999999999');
  await expect(page.locator('[data-project-editor]')).toHaveCount(0);
  await expect(
    page.getByText('Page not found.', { exact: false }),
  ).toBeVisible();
  mkdirSync('output/playwright', { recursive: true });
  for (const [name, width, height] of [
    ['desktop', 1440, 1050],
    ['tablet', 820, 1180],
    ['mobile', 390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto(base + '/admin/projects');
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      name + ' projects list overflow',
    );
    await page.screenshot({
      path: 'output/playwright/admin-projects-' + name + '.png',
      fullPage: true,
    });
    await project.getByRole('link', { name: 'Edit', exact: true }).click();
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      name + ' project editor overflow',
    );
    await page.screenshot({
      path: 'output/playwright/admin-project-editor-' + name + '.png',
      fullPage: true,
    });
    await page.goto(base + '/projects');
    const publicProject = page
      .locator('.project-card')
      .filter({ hasText: 'Browser quality project' });
    const image = publicProject.locator('img');
    await expect(image).toBeVisible();
    const dimensions = await image.evaluate((element: HTMLImageElement) => ({
      width: element.clientWidth,
      height: element.clientHeight,
      naturalWidth: element.naturalWidth,
      naturalHeight: element.naturalHeight,
    }));
    assert(
      Math.abs(
        dimensions.width / dimensions.height -
          dimensions.naturalWidth / dimensions.naturalHeight,
      ) < 0.01,
      'Cover must retain its natural aspect ratio',
    );
    const statusColors = await publicProject
      .locator('.project-status')
      .evaluate((element) => ({
        text: getComputedStyle(element).color,
        dot: getComputedStyle(element.querySelector('.project-status-dot')!)
          .backgroundColor,
      }));
    assert.equal(statusColors.text, 'rgb(24, 115, 67)');
    assert.equal(statusColors.dot, statusColors.text);
    await page.screenshot({
      path: 'output/playwright/public-projects-' + name + '.png',
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1280, height: 720 });

  await page.goto(base + '/admin/inbox');
  await page.getByText('Add an X post manually', { exact: true }).click();
  const manual = page.locator('form[action="/api/admin/manual-x"]');
  await manual.locator('[name=x_id]').fill(String(Date.now()));
  await manual.locator('[name=date]').fill('2025-04-03T12:00');
  await manual
    .locator('[name=text]')
    .fill('Browser inbox quality fixture\nA second line');
  await manual.getByRole('button', { name: 'Add to inbox' }).click();
  await expect(
    page
      .locator('.inbox-item')
      .filter({ hasText: 'Browser inbox quality fixture' }),
  ).toBeVisible();
  await page
    .locator('input[type=search][name=q]')
    .fill('Browser inbox quality fixture');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.locator('#inbox-selection input[name=selected]').check();
  await expect(page.locator('[data-selection-count]')).toHaveText('1 selected');
  await page
    .locator('#inbox-selection input[name=title]')
    .fill('A draft from the inbox');
  await page
    .getByRole('button', { name: 'Create draft from selection' })
    .click();
  await expect(page.locator('#post-title')).toHaveValue(
    'A draft from the inbox',
  );
  await expect(page.locator('#post-status')).toHaveText('Draft');

  const scheduling = await create({
    title: 'Scheduling quality fixture',
    body: 'Future content',
  });
  await page.goto(base + '/admin/edit?id=' + scheduling.id);
  await page.getByText('Schedule publication', { exact: true }).click();
  await page.locator('#scheduled-at').fill('2099-04-03T12:00');
  await page
    .getByRole('button', { name: 'Schedule post', exact: true })
    .click();
  await expect(page.locator('#post-status')).toHaveText('Scheduled');
  assert.equal(
    (await context.request.get(base + '/posts/' + scheduling.slug)).status(),
    404,
  );
  const scheduledExport = unzipSync(
    await (await context.request.get(base + '/api/admin/export')).body(),
  );
  assert.equal(
    JSON.parse(strFromU8(scheduledExport['content.json'])).posts.find(
      (post: any) => post.id === scheduling.id,
    ).published_at,
    '2099-04-03T10:00:00.000Z',
    'Schedule uses the browser timezone and stores UTC',
  );
  await create({ title: 'Tag quality fixture', tags: 'admin-browser-topic' });
  await page.goto(base + '/admin/tags');
  await page.locator('#old-tag').selectOption('admin-browser-topic');
  await expect(page.locator('#tag-impact')).toContainText('1 posts');
  await page.locator('input[name=new]').fill('admin-browser-merged');
  await page.getByRole('button', { name: 'Update tag across posts' }).click();
  await expect(
    page.getByRole('link', { name: '#admin-browser-merged', exact: true }),
  ).toBeVisible();

  mkdirSync('output/playwright', { recursive: true });
  await page.goto(base + '/admin/edit?id=' + visual.id);
  for (const [name, width, height] of [
    ['desktop', 1440, 1050],
    ['tablet', 820, 1180],
    ['mobile', 390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      name + ' must not overflow horizontally',
    );
    await expect(
      page.getByRole('button', { name: 'Save draft', exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: 'output/playwright/admin-editor-' + name + '.png',
      fullPage: true,
    });
  }
  assert.deepEqual(errors, [], 'Admin browser errors');
  assert.deepEqual(violations, [], 'Admin CSP violations');
  await page.close();
  console.log(
    'Admin browser passed: exact text round trips, autosave, private publication, conflict/offline recovery, pins, bulk actions, visual tables, indentation repair, responsive layouts.',
  );
}
