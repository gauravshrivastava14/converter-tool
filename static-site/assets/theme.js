// Dark/light theme toggle + mobile nav. The initial theme itself is set
// synchronously by the inline script in <head> (before first paint) so
// there's no flash of the wrong theme; this module only wires up the
// interactive bits once the DOM is ready.

const STORAGE_KEY = "pdfsetu-theme";

export function initThemeToggle() {
  const root = document.documentElement;
  const btn = document.getElementById("themeToggle");
  if (!btn) return;

  btn.addEventListener("click", () => {
    const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* ignore */ }
  });

  // Follow the OS preference live, but only for users who haven't picked a
  // theme of their own on this site yet.
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener?.("change", e => {
    let stored = null;
    try { stored = localStorage.getItem(STORAGE_KEY); } catch { /* ignore */ }
    if (!stored) root.setAttribute("data-theme", e.matches ? "dark" : "light");
  });
}

export function initMobileNav() {
  const navToggle = document.getElementById("navToggle");
  const navLinks = document.getElementById("navLinks");
  if (!navToggle || !navLinks) return;

  navToggle.addEventListener("click", () => {
    const open = navLinks.classList.toggle("open");
    navToggle.setAttribute("aria-expanded", String(open));
    navToggle.classList.toggle("open", open);
  });

  // Dropdown: hover already opens it for mouse users (CSS); this click
  // handler makes it work for touch/mobile too, where hover never fires.
  const dropdown = document.querySelector(".nav-dropdown");
  const dropdownBtn = document.querySelector(".nav-dropdown-btn");
  if (dropdown && dropdownBtn) {
    dropdownBtn.addEventListener("click", e => {
      e.stopPropagation();
      dropdown.classList.toggle("open");
    });
  }

  document.addEventListener("click", e => {
    if (dropdown && !dropdown.contains(e.target)) dropdown.classList.remove("open");
    if (!navLinks.contains(e.target) && !navToggle.contains(e.target) && navLinks.classList.contains("open")) {
      navLinks.classList.remove("open");
      navToggle.setAttribute("aria-expanded", "false");
      navToggle.classList.remove("open");
    }
  });
}

export function setFooterYear() {
  const el = document.getElementById("footerYear");
  if (el) el.textContent = new Date().getFullYear();
}
