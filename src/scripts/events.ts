declare global {
  interface Window {
    umami?: { track: (name: string, data?: Record<string, string>) => void };
  }
}
if (
  !location.pathname.startsWith('/admin') &&
  !navigator.webdriver &&
  new URLSearchParams(location.search).get('tracking') !== 'off'
) {
  document.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest('a');
    if (!target) return;
    if (target.hasAttribute('data-project'))
      window.umami?.track('project-click', {
        project: target.getAttribute('data-project') || '',
      });
    else if (new URL(target.href).origin !== location.origin)
      window.umami?.track('outbound-click', { url: target.href });
  });
  if (
    document.querySelector('[data-no-results]') &&
    new URLSearchParams(location.search).has('q')
  ) {
    const report = () => window.umami?.track('search-no-results');
    if (window.umami) report();
    else
      document.addEventListener('blog:analytics-ready', report, { once: true });
  }
}
export {};
