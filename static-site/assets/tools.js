export const TOOLS = {
  "word-to-pdf": {
    label: "Word to PDF",
    hero_title: "Word to PDF",
    tagline: "Select multiple Word documents and convert them all to PDF in one go " +
             "&mdash; fast, free, and entirely in your browser. Your files never leave your device.",
    input_exts: [".docx", ".docm"],
    output_ext: ".pdf",
    button_label: "Select Word Files",
    drop_hint: "or drop .docx / .docm files here &mdash; multiple allowed",
  },
  "pdf-to-word": {
    label: "PDF to Word",
    hero_title: "PDF to Word",
    tagline: "Extracts the text from each page and rebuilds it as an editable Word " +
             "document &mdash; convert as many at once as you like, entirely in your browser.",
    input_exts: [".pdf"],
    output_ext: ".docx",
    button_label: "Select PDF Files",
    drop_hint: "or drop .pdf files here &mdash; multiple allowed",
  },
  "pdf-to-ppt": {
    label: "PDF to PPT",
    hero_title: "PDF to PPT",
    tagline: "Turn each PDF page into a PowerPoint slide &mdash; every page is placed as " +
             "a full-slide image, so the layout matches the PDF exactly.",
    input_exts: [".pdf"],
    output_ext: ".pptx",
    button_label: "Select PDF Files",
    drop_hint: "or drop .pdf files here &mdash; multiple allowed",
  },
  "ppt-to-excel": {
    label: "PPT to Excel",
    hero_title: "PPT to Excel",
    tagline: "Extract the text from every slide into an Excel sheet &mdash; one row per " +
             "slide, with its title and content in separate columns.",
    input_exts: [".pptx", ".pptm"],
    output_ext: ".xlsx",
    button_label: "Select PPT Files",
    drop_hint: "or drop .pptx / .pptm files here &mdash; multiple allowed",
  },
};

export const DEFAULT_TOOL = "word-to-pdf";
