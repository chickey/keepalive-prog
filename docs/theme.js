// Light/dark toggle shared by the config and flash pages.
// System setting by default; the button overrides it. Switching back to the
// system's own choice clears the override so the page follows the OS again.

const sysDark = window.matchMedia('(prefers-color-scheme: dark)');

function effectiveTheme() {
  return document.documentElement.dataset.theme || (sysDark.matches ? 'dark' : 'light');
}

export function initTheme(btn) {
  function render() {
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    btn.dataset.next = next;
    btn.setAttribute('aria-label', `Switch to ${next} mode`);
    btn.title = `Switch to ${next} mode`;
  }

  function toggle() {
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    const system = sysDark.matches ? 'dark' : 'light';
    try {
      if (next === system) { delete document.documentElement.dataset.theme; localStorage.removeItem('ka-theme'); }
      else { document.documentElement.dataset.theme = next; localStorage.setItem('ka-theme', next); }
    } catch {
      document.documentElement.dataset.theme = next;
    }
    render();
  }

  btn.addEventListener('click', toggle);
  sysDark.addEventListener('change', render);
  render();
}
