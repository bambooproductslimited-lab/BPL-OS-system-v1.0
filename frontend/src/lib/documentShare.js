// Renders a printable document node (an Estimate/Quotation/Invoice/Receipt
// preview) to a real PDF client-side, then hands it to the device's native
// share sheet (email, WhatsApp, text message, AirDrop, ...) via the Web
// Share API. Desktop browsers that can't share files just get the PDF
// downloaded instead, so it can be attached/shared manually. Elements
// marked `.no-print` (the action buttons themselves, the dialog backdrop)
// are excluded from the rendered page.
//
// jspdf/html2canvas (~600KB combined) are dynamically imported here rather
// than at module scope, so they land in their own chunk and only download
// when someone actually clicks Share — not on every page load.
async function renderToPdfBlob(node) {
  var jsPDFModule = await import('jspdf');
  var html2canvasModule = await import('html2canvas');
  var jsPDF = jsPDFModule.default;
  var html2canvas = html2canvasModule.default;

  // html2canvas captures the node at whatever size it currently occupies on
  // screen, and the result is then stretched to the A4 page. Left alone,
  // that makes the PDF a tenant receives depend on the window width of
  // whoever pressed Share — generate it on a phone and the document comes
  // out in its cramped narrow-screen layout, with anything that didn't fit
  // clipped off the edge.
  //
  // So the node is pinned to a fixed A4 content width (794px ~ 210mm at
  // 96dpi) for the capture and restored immediately after. The padding is
  // pinned too, because it scales with the viewport. The PDF is then
  // byte-identical from a phone, a laptop or a 4K monitor.
  var A4_WIDTH_PX = 794;
  var saved = {
    width: node.style.width,
    minWidth: node.style.minWidth,
    maxWidth: node.style.maxWidth,
    maxHeight: node.style.maxHeight,
    overflow: node.style.overflow,
    padding: node.style.padding,
    flexShrink: node.style.flexShrink
  };
  node.style.width = A4_WIDTH_PX + 'px';
  // The preview is a flex item inside the dialog backdrop, so width alone is
  // only a suggestion — it shrinks straight back to the viewport. min-width
  // and flex-shrink:0 are what actually hold it open for the capture.
  node.style.minWidth = A4_WIDTH_PX + 'px';
  node.style.maxWidth = A4_WIDTH_PX + 'px';
  node.style.flexShrink = '0';
  node.style.maxHeight = 'none';
  node.style.overflow = 'visible';
  node.style.padding = '40px';

  var canvas;
  try {
    canvas = await html2canvas(node, {
      scale: 2,
      backgroundColor: '#ffffff',
      width: A4_WIDTH_PX,
      windowWidth: A4_WIDTH_PX,
      ignoreElements: function (el) { return !!(el.classList && el.classList.contains('no-print')); }
    });
  } finally {
    // Restore even if the capture throws, so a failed share doesn't leave
    // the dialog stuck at 794px on a phone.
    node.style.width = saved.width;
    node.style.minWidth = saved.minWidth;
    node.style.maxWidth = saved.maxWidth;
    node.style.flexShrink = saved.flexShrink;
    node.style.maxHeight = saved.maxHeight;
    node.style.overflow = saved.overflow;
    node.style.padding = saved.padding;
  }

  var pdf = new jsPDF({ unit: 'pt', format: 'a4' });
  var pageWidth = pdf.internal.pageSize.getWidth();
  var pageHeight = pdf.internal.pageSize.getHeight();
  var imgWidth = pageWidth;
  var imgHeight = (canvas.height * imgWidth) / canvas.width;
  var imgData = canvas.toDataURL('image/png');

  var heightLeft = imgHeight;
  var position = 0;
  pdf.addImage(imgData, 'PNG', 0, position, imgWidth, imgHeight);
  heightLeft -= pageHeight;
  while (heightLeft > 0) {
    position -= pageHeight;
    pdf.addPage();
    pdf.addImage(imgData, 'PNG', 0, position, imgWidth, imgHeight);
    heightLeft -= pageHeight;
  }

  return pdf.output('blob');
}

function downloadBlob(blob, filename) {
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// node: the DOM element to render. filename: e.g. "Invoice-INV-2026-0001.pdf".
// shareTitle/shareText: passed to the native share sheet when available.
export async function shareOrDownloadPdf(node, filename, shareTitle, shareText) {
  var blob = await renderToPdfBlob(node);
  var file = new File([blob], filename, { type: 'application/pdf' });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    await navigator.share({ files: [file], title: shareTitle, text: shareText });
    return 'shared';
  }
  downloadBlob(blob, filename);
  return 'downloaded';
}
