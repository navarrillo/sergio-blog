export {};

const form = document.querySelector<HTMLFormElement>('[data-project-editor]');
if (form) {
  const field = (name: string) =>
    form.elements.namedItem(name) as
      | HTMLInputElement
      | HTMLTextAreaElement
      | HTMLSelectElement;
  const names = ['name', 'description', 'status', 'url', 'source_url', 'image'];
  const snapshot = () => JSON.stringify(names.map((name) => field(name).value));
  let saved = snapshot();
  let saving = saved;
  let pending = false;
  const status = form.querySelector<HTMLElement>('[data-project-save-status]')!;
  const preview = document.querySelector<HTMLElement>('.project-preview')!;
  const update = () => {
    status.textContent = pending
      ? 'Saving…'
      : snapshot() === saved
        ? 'No unsaved changes'
        : 'Unsaved changes';
    preview.querySelector('[data-project-preview-name]')!.textContent =
      field('name').value || 'Project name';
    preview.querySelector('[data-project-preview-description]')!.textContent =
      field('description').value ||
      'Your project description will appear here.';
    const badge = preview.querySelector<HTMLElement>(
      '[data-project-preview-status]',
    )!;
    badge.dataset.status = field('status').value;
    badge.querySelector('[data-status-label]')!.textContent =
      field('status').value;
    form.querySelector('[data-description-count]')!.textContent =
      `${field('description').value.length.toLocaleString()} / 2,000 characters`;
    for (const name of ['url', 'source_url']) {
      const link = preview.querySelector<HTMLAnchorElement>(
        `[data-project-preview-link="${name}"]`,
      )!;
      let url: URL | undefined;
      try {
        url = new URL(field(name).value);
      } catch {
        /* Incomplete optional URL. */
      }
      const valid = url && ['http:', 'https:'].includes(url.protocol);
      link.hidden = !valid;
      if (valid) {
        link.href = url!.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      } else link.removeAttribute('href');
    }
  };
  form.addEventListener('input', update);
  form.addEventListener('change', update);
  form.addEventListener('admin:saving', () => {
    saving = snapshot();
    pending = true;
    update();
  });
  form.addEventListener('admin:saved', () => {
    saved = saving;
    pending = false;
    update();
  });
  form.addEventListener('admin:save-error', () => {
    pending = false;
    status.textContent = 'Save failed. Your changes are still here.';
  });
  window.addEventListener('beforeunload', (event) => {
    if (snapshot() !== saved) {
      event.preventDefault();
    }
  });
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (!pending) form.requestSubmit();
    }
  });
  update();
}
