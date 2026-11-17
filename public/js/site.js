/* Shared site behaviour: mobile nav, footer year. */
(() => {
  'use strict';
  const toggle = document.querySelector('.nav-toggle');
  const nav = document.getElementById('site-nav');
  if (toggle && nav) {
    toggle.addEventListener('click', () => {
      const open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
    });
    nav.addEventListener('click', (e) => {
      if (e.target.closest('a')) {
        nav.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
  }
  document.querySelectorAll('[data-year]').forEach((el) => (el.textContent = String(new Date().getFullYear())));
})();
