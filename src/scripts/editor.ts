const form = document.querySelector<HTMLFormElement>('#post-form');
if (form) {
  import('./post-editor')
    .then(({ setupEditor }) => setupEditor(form))
    .catch(() => {
      const source = document.querySelector<HTMLElement>('#source-label');
      if (source) source.hidden = false;
      const warning = document.querySelector<HTMLElement>('#source-warning');
      if (warning) {
        warning.hidden = false;
        warning.textContent =
          'The visual editor could not load. You can save your Markdown with Save draft. Reload to restore autosave and publication controls.';
      }
    });
}
