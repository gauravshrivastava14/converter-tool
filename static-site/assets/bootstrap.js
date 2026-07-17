// Populates the page shell from TOOLS config and wires up the tool-specific
// converter module. Every page's <body data-tool-id="..."> is the only thing
// that differs between the 5 HTML files - everything else is generated here
// so tagline/label copy lives in one place (tools.js) instead of being
// duplicated across 5 static files.
import { TOOLS } from './tools.js';
import { initToolPage, showFatalError } from './ui.js';

const toolId = document.body.dataset.toolId;
const tool = TOOLS[toolId];

document.title = `${tool.label} — PDFSetu`;
document.getElementById('heroTitle').textContent = tool.hero_title;
document.getElementById('heroTagline').innerHTML = tool.tagline;
document.getElementById('selectBtnLabel').textContent = tool.button_label;
document.getElementById('dropHint').innerHTML = tool.drop_hint;
document.getElementById('fileInput').accept = tool.input_exts.join(',');

const menu = document.getElementById('navToolsMenu');
Object.entries(TOOLS).forEach(([slug, t]) => {
  const a = document.createElement('a');
  a.href = `/${slug}/`;
  a.textContent = t.label;
  if (slug === toolId) a.classList.add('active');
  menu.appendChild(a);
});

import(`./converters/${toolId}.js`)
  .then(mod => initToolPage({ tool, convert: mod.convert }))
  .catch(err => {
    console.error('Failed to load converter module for', toolId, err);
    showFatalError('Failed to load the converter for this tool. Please refresh the page.');
  });
