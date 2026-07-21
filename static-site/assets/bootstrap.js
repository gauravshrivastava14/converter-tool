// Populates the page shell from TOOLS config and wires up the tool-specific
// converter module. Every page's <body data-tool-id="..."> is the only thing
// that differs between the 5 HTML files - everything else is generated here
// so tagline/label copy lives in one place (tools.js) instead of being
// duplicated across 5 static files.
import { TOOLS, FORMATS } from './tools.js';
import { initToolPage, showFatalError } from './ui.js';
import { initThemeToggle, initMobileNav, setFooterYear } from './theme.js';

const toolId = document.body.dataset.toolId;
const tool = TOOLS[toolId];

document.title = `${tool.label} — PDFSetu`;
document.getElementById('heroTitle').textContent = tool.hero_title;
document.getElementById('heroTagline').innerHTML = tool.tagline;
document.getElementById('selectBtnLabel').textContent = tool.button_label;
document.getElementById('dropHint').innerHTML = tool.drop_hint;
document.getElementById('fileInput').accept = tool.input_exts.join(',');

const metaDesc = document.querySelector('meta[name="description"]');
if (metaDesc && tool.meta_description) metaDesc.setAttribute('content', tool.meta_description);

const menu = document.getElementById('navToolsMenu');
Object.entries(TOOLS).forEach(([slug, t]) => {
  const a = document.createElement('a');
  a.href = `/${slug}/`;
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.style.background = FORMATS[t.to_fmt].color;
  a.append(dot, t.label);
  if (slug === toolId) a.classList.add('active');
  menu.appendChild(a);
});

const toolsGrid = document.getElementById('toolsGrid');
if (toolsGrid) {
  Object.entries(TOOLS).forEach(([slug, t]) => {
    const card = document.createElement('a');
    card.href = `/${slug}/`;
    card.className = 'tool-card' + (slug === toolId ? ' current' : '');

    const badges = document.createElement('div');
    badges.className = 'tool-card-badges';
    const from = document.createElement('span');
    from.className = 'fmt-badge';
    from.style.background = FORMATS[t.from_fmt].color;
    from.textContent = FORMATS[t.from_fmt].label;
    const arrow = document.createElement('span');
    arrow.className = 'arrow';
    arrow.textContent = '→';
    const to = document.createElement('span');
    to.className = 'fmt-badge';
    to.style.background = FORMATS[t.to_fmt].color;
    to.textContent = FORMATS[t.to_fmt].label;
    badges.append(from, arrow, to);

    const h3 = document.createElement('h3');
    h3.textContent = t.label;
    const p = document.createElement('p');
    p.textContent = t.short_desc;
    const go = document.createElement('span');
    go.className = 'go';
    go.textContent = slug === toolId ? "You're here" : 'Convert now →';

    card.append(badges, h3, p, go);
    toolsGrid.appendChild(card);
  });
}

const optionsBox = document.getElementById('toolOptions');
if (optionsBox && tool.options) {
  tool.options.forEach(opt => {
    const field = document.createElement('label');
    field.className = 'opt-field';
    const span = document.createElement('span');
    span.textContent = opt.label;

    let control;
    if (opt.type === 'text' || opt.type === 'number') {
      control = document.createElement('input');
      control.type = opt.type;
      control.className = 'opt-input';
      control.value = opt.default ?? '';
      if (opt.type === 'number') { control.min = '1'; control.step = '1'; }
    } else {
      control = document.createElement('select');
      opt.choices.forEach(c => {
        const o = document.createElement('option');
        o.value = c.value;
        o.textContent = c.label;
        if (c.value === opt.default) o.selected = true;
        control.appendChild(o);
      });
    }
    control.dataset.optId = opt.id;

    field.append(span, control);
    optionsBox.appendChild(field);
  });
  optionsBox.style.display = 'flex';
}

initThemeToggle();
initMobileNav();
setFooterYear();

// Merge/split are N-in/1-out or 1-in/N-out, so they drive the shared panels
// with their own page controller instead of the standard 1-in/1-out
// initToolPage() batch flow every other tool uses.
const modulePath = tool.custom ? `./pages/${toolId}.js` : `./converters/${toolId}.js`;
import(modulePath)
  .then(mod => tool.custom ? mod.init(tool) : initToolPage({ tool, convert: mod.convert }))
  .catch(err => {
    console.error('Failed to load module for', toolId, err);
    showFatalError('Failed to load this tool. Please refresh the page.');
  });
